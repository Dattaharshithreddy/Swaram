"""Make training audio in one voice with IndicF5 (GPU), resumable.

    python generate.py --ref ref.wav --ref-text "..." --out data --count 1500
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
from swaram_edge.runner import normalize_ref_text, trim_silence  # noqa: E402
from swaram_edge.vocos_loader import build_vocos_24khz, load_vocos  # noqa: E402

import corpus  # noqa: E402
import emotions  # noqa: E402

SR = 24000
HOP = 256
TARGET_RMS = 0.1


def load_ref(path: str) -> np.ndarray:
    import librosa

    wav, _ = librosa.load(path, sr=SR, mono=True)
    return trim_silence(wav.astype(np.float32))[: 15 * SR]


def shards_requested(shard: str) -> bool:
    return shard.split("/")[1] != "1"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--ref", required=True)
    p.add_argument("--ref-text", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--count", type=int, default=1500)
    p.add_argument("--steps", type=int, default=32)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--random", type=int, default=0, help="Tests: random model with this many layers")
    p.add_argument("--shard", default="0/1", help="i/n: this process makes every n-th sentence (one per GPU)")
    p.add_argument("--emotion", default="", help="Only sentences assigned to this emotion (emotions.json); '' = normal tone")
    args = p.parse_args()

    out = Path(args.out)
    (out / "wav").mkdir(parents=True, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"

    if args.random:
        vocab = [" ", ",", "."] + [chr(c) for c in range(0x0C00, 0x0C80)]
        cfg = F5Config(depth=args.random, vocab_size=len(vocab))
        torch.manual_seed(0)
        dit = build_dit(cfg)
        vocos = build_vocos_24khz()
    else:
        from swaram_edge.export import fetch_indicf5

        ckpt, vocab_path = fetch_indicf5()
        vocab = read_vocab(vocab_path)
        dit, cfg = load_dit(ckpt, len(vocab))
        vocos = load_vocos()

    from f5_tts.model.cfm import CFM

    cfm = CFM(transformer=dit, vocab_char_map={c: i for i, c in enumerate(vocab)}).to(device).eval()
    vocos = vocos.to(device).eval()
    mel_enc = MelEncoder().to(device).eval()

    ref = load_ref(args.ref)
    ref_rms = float(np.sqrt(np.mean(ref**2) + 1e-12))
    if ref_rms < TARGET_RMS:
        ref = ref * (TARGET_RMS / ref_rms)
    ref_text = normalize_ref_text(args.ref_text)
    with torch.no_grad():
        ref_mel = mel_enc(torch.from_numpy(ref)[None].to(device))  # (1, frames, 100)
    ref_frames = ref_mel.shape[1]
    ref_bytes = max(1, len(ref_text.encode("utf-8")))
    print(f"Reference: {ref.size / SR:.1f} s, {ref_frames} frames, device={device}")

    sents_file = out / "sentences.json"
    if not sents_file.exists() and shards_requested(args.shard):
        raise SystemExit("Run once with --shard 0/1 --count N (or write sentences.json) before sharding")
    if sents_file.exists():
        sents = json.loads(sents_file.read_text("utf-8"))
    else:
        sents = corpus.sentences(args.count)
        sents_file.write_text(json.dumps(sents, ensure_ascii=False, indent=0), "utf-8")
    shard, shards = (int(x) for x in args.shard.split("/"))
    assigned = emotions.load(out)
    want = args.emotion or None
    todo = [
        (i, s) for i, s in enumerate(sents)
        if i % shards == shard
        and (not assigned or assigned.get(i) == want)
        and not (out / "wav" / f"s{i:05d}.wav").exists()
    ]
    todo.sort(key=lambda x: len(x[1].encode()))  # similar lengths batch well
    print(f"{len(sents)} sentences, {len(todo)} to generate ({want or 'normal tone'})")

    t0 = time.time()
    done = 0
    bad = 0
    fp32_note = False
    amp = torch.autocast("cuda", dtype=torch.float16) if device == "cuda" else torch.autocast("cpu", enabled=False)
    for b in range(0, len(todo), args.batch):
        batch = todo[b : b + args.batch]
        durs = [min(ref_frames + int(ref_frames / ref_bytes * len(s.encode("utf-8"))), 4096) for _, s in batch]
        def sample(autocast):
            with torch.no_grad(), autocast:
                m, _ = cfm.sample(
                    cond=ref_mel.expand(len(batch), -1, -1),
                    text=[ref_text + s for _, s in batch],
                    duration=torch.tensor(durs, device=device),
                    lens=torch.full((len(batch),), ref_frames, device=device, dtype=torch.long),
                    steps=args.steps,
                    cfg_strength=2.0,
                    sway_sampling_coef=-1.0,
                )
            return m.float()

        mel = sample(amp)
        if not torch.isfinite(mel).all():
            # Half precision overflowed (it happens on T4s): make this batch again at full precision.
            if not fp32_note:
                print("half precision gave invalid audio; using full precision", flush=True)
                fp32_note = True
            amp = torch.autocast("cuda", enabled=False) if device == "cuda" else amp
            mel = sample(amp)
        with torch.no_grad():
            for k, (i, s) in enumerate(batch):
                gen = mel[k : k + 1, ref_frames : durs[k]].permute(0, 2, 1)
                wav = vocos.decode(gen)[0].float().cpu().numpy()  # the vocoder always at full precision
                if ref_rms < TARGET_RMS:
                    wav = wav * (ref_rms / TARGET_RMS)
                if not np.isfinite(wav).all() or np.abs(wav).max() < 1e-3:
                    print(f"skipping s{i:05d}: silent or invalid")
                    bad += 1
                    continue
                sf.write(out / "wav" / f"s{i:05d}.wav", np.clip(wav, -1, 1), SR)
                done += 1
        if bad >= 24 and done == 0:
            raise SystemExit(f"The first {bad} sentences all came out silent or invalid; stopping instead of wasting GPU time.")
        rate = (time.time() - t0) / max(1, done)
        print(f"{done}/{len(todo)} done, {rate:.2f} s per sentence, about {rate * (len(todo) - done) / 60:.0f} min left", flush=True)


if __name__ == "__main__":
    main()
