"""Render a Swaram script on a GPU at the highest quality (full IndicF5, 32 steps).

The app sends job.json: the voices (reference recording + its words, and an
optional fine-tuned checkpoint) and the lines to make. Each line is written as
parts/part-00007.wav (24 kHz) for the app to put into the project.

    python render.py --job job.json --out out
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "edge"))

from swaram_edge.f5 import F5Config, build_dit, load_dit, read_vocab  # noqa: E402
from swaram_edge.graphs import MelEncoder  # noqa: E402
from swaram_edge.runner import chunk_text, normalize_ref_text, trim_silence  # noqa: E402
from swaram_edge.vocos_loader import build_vocos_24khz, load_vocos  # noqa: E402

SR = 24000
HOP = 256
TARGET_RMS = 0.1
MAX_PART_SECONDS = 12  # same as the app: longer pieces are where the model starts repeating
CROSS_FADE = 0.15


def shorten_pauses(wav: np.ndarray, max_pause_ms: int = 250) -> np.ndarray:
    """Same as the app (dsp.ts shortenPauses): pauses in the reference become gaps in the output."""
    frame = int(0.02 * SR)
    n = wav.size // frame
    if n < 5:
        return wav
    db = 20 * np.log10(np.sqrt(np.mean(wav[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12))
    loud = np.sort(db)[::-1][int(n * 0.1)]
    quiet = db < max(-45.0, loud - 30)
    max_frames = max(1, round(max_pause_ms / 20))
    keep, f = [], 0
    while f < n:
        start = f
        while f < n and quiet[f] == quiet[start]:
            f += 1
        if not quiet[start] or f - start <= max_frames:
            keep.append(wav[start * frame : f * frame])
        else:
            mid = start + (f - start - max_frames) // 2
            keep.append(wav[mid * frame : (mid + max_frames) * frame])
    keep.append(wav[n * frame :])
    return np.concatenate(keep)


def cross_fade(pieces: list[np.ndarray]) -> np.ndarray:
    out = pieces[0]
    k = int(CROSS_FADE * SR)
    for nxt in pieces[1:]:
        m = min(k, out.size, nxt.size)
        if m == 0:
            out = np.concatenate([out, nxt])
            continue
        fade = np.linspace(0, 1, m, dtype=np.float32)
        out = np.concatenate([out[:-m], out[-m:] * (1 - fade) + nxt[:m] * fade, nxt[m:]])
    return out


class Voice:
    def __init__(self, mel_enc, device: str, wav_path: str, text: str):
        import librosa

        wav, _ = librosa.load(wav_path, sr=SR, mono=True)
        wav = shorten_pauses(trim_silence(wav.astype(np.float32)))[: 15 * SR]
        self.rms = float(np.sqrt(np.mean(wav**2) + 1e-12))
        if self.rms < TARGET_RMS:
            wav = wav * (TARGET_RMS / self.rms)
        self.text = normalize_ref_text(text)
        with torch.no_grad():
            self.mel = mel_enc(torch.from_numpy(wav)[None].to(device))
        self.frames = self.mel.shape[1]
        self.bytes = max(1, len(self.text.encode("utf-8")))

    def max_bytes(self) -> int:
        ref_seconds = self.frames * HOP / SR
        return max(60, int(self.bytes / max(ref_seconds, 1e-3) * min(MAX_PART_SECONDS, 25 - ref_seconds)))


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--job", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--random", type=int, default=0, help="Tests: random model with this many layers")
    args = p.parse_args()

    job = json.loads(Path(args.job).read_text("utf-8"))
    base = Path(args.job).resolve().parent
    out = Path(args.out)
    (out / "parts").mkdir(parents=True, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    steps = int(job.get("steps", 32))
    cfg_strength = float(job.get("cfg", 2.0))

    if args.random:
        vocab = [" ", ",", "."] + [chr(c) for c in range(0x0C00, 0x0C80)]
        torch.manual_seed(0)
        base_dit = build_dit(F5Config(depth=args.random, vocab_size=len(vocab)))
        vocos = build_vocos_24khz()
        base_ckpt = None
    else:
        from swaram_edge.export import fetch_indicf5

        base_ckpt, vocab_path = fetch_indicf5()
        vocab = read_vocab(vocab_path)
        base_dit, _ = load_dit(base_ckpt, len(vocab))
        vocos = load_vocos()

    from f5_tts.model.cfm import CFM

    vocab_map = {c: i for i, c in enumerate(vocab)}
    vocos = vocos.to(device).eval()
    mel_enc = MelEncoder().to(device).eval()
    models: dict[str, CFM] = {}

    def model_for(ckpt: str | None) -> CFM:
        key = ckpt or ""
        if key not in models:
            if ckpt:
                dit, _ = load_dit(ckpt, len(vocab))  # a voice's fine-tuned big model
            else:
                dit = base_dit
            models.clear()  # one model on the GPU at a time
            models[key] = CFM(transformer=dit, vocab_char_map=vocab_map).to(device).eval()
        return models[key]

    voices = {k: Voice(mel_enc, device, str(base / v["wav"]), v["text"]) for k, v in job["voices"].items()}
    parts = sorted(job["parts"], key=lambda x: (job["voices"][x["voice"]].get("ckpt") or "", x["voice"]))
    t0 = time.time()
    for n, part in enumerate(parts, 1):
        v = voices[part["voice"]]
        ckpt = job["voices"][part["voice"]].get("ckpt")
        cfm = model_for(str(base / ckpt) if ckpt else None)
        speed = float(part.get("speed", 1.0))
        pieces = []
        for text in chunk_text(part["text"], v.max_bytes()):
            dur = v.frames + int(v.frames / v.bytes * len(text.encode("utf-8")) / speed)
            dur = min(max(dur, v.frames + 1), 4096)
            with torch.no_grad():
                mel, _ = cfm.sample(
                    cond=v.mel,
                    text=[v.text + text],
                    duration=torch.tensor([dur], device=device),
                    lens=torch.tensor([v.frames], device=device, dtype=torch.long),
                    steps=steps,
                    cfg_strength=cfg_strength,
                    sway_sampling_coef=-1.0,
                )
                gen = mel[:, v.frames : dur].float().permute(0, 2, 1)
                wav = vocos.decode(gen)[0].float().cpu().numpy()
            if v.rms < TARGET_RMS:
                wav = wav * (v.rms / TARGET_RMS)
            pieces.append(wav.astype(np.float32))
        audio = np.clip(cross_fade(pieces), -1, 1)
        sf.write(out / "parts" / f"part-{int(part['i']):05d}.wav", audio, SR, subtype="PCM_16")
        rate = (time.time() - t0) / n
        print(f"line {n}/{len(parts)} done, {rate:.1f} s per line", flush=True)
    (out / "render.json").write_text(json.dumps({"parts": [int(x["i"]) for x in parts], "steps": steps}), "utf-8")
    print("All lines made.")


if __name__ == "__main__":
    main()
