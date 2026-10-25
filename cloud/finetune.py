"""Fine-tune IndicF5 (the big model) on one person's recordings, like
"professional voice cloning": the model itself learns the voice, so it sounds
more like them and stays steadier than cloning from a few seconds.

data/metadata.csv lines are "file.wav|text"; wavs in data/wavs/. Writes
out/voice-model-<id>.safetensors (half-precision weights, the format
swaram_edge.f5.load_dit reads) and out/sample.wav.

    python finetune.py --data data --out out --id abc --hours 2.5
"""

from __future__ import annotations

import argparse
import math
import random
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

SR = 24000
HOP = 256
TARGET_RMS = 0.1


def load_clips(data: Path, mel_enc, device: str) -> list[tuple[torch.Tensor, str]]:
    import librosa

    clips = []
    for line in (data / "metadata.csv").read_text("utf-8").splitlines():
        if "|" not in line:
            continue
        name, text = line.split("|", 1)
        path = data / "wavs" / name
        if not path.exists() or not text.strip():
            continue
        wav, _ = librosa.load(str(path), sr=SR, mono=True)
        wav = trim_silence(wav.astype(np.float32))
        sec = wav.size / SR
        if not 1.0 <= sec <= 20.0:
            continue
        rms = float(np.sqrt(np.mean(wav**2) + 1e-12))
        wav = wav * (TARGET_RMS / max(rms, 1e-4))  # same level the model sees when speaking
        with torch.no_grad():
            mel = mel_enc(torch.from_numpy(wav)[None].to(device))[0].cpu()
        clips.append((mel, text.strip()))
    return clips


def batches(clips, max_frames: int, rng: random.Random):
    """Similar lengths together, at most max_frames of audio per batch."""
    order = sorted(range(len(clips)), key=lambda i: clips[i][0].shape[0])
    out, cur, longest = [], [], 0
    for i in order:
        n = clips[i][0].shape[0]
        if cur and max(longest, n) * (len(cur) + 1) > max_frames:
            out.append(cur)
            cur, longest = [], 0
        cur.append(i)
        longest = max(longest, n)
    if cur:
        out.append(cur)
    rng.shuffle(out)
    return out


def save_weights(model: torch.nn.Module, path: Path) -> None:
    from safetensors.torch import save_file

    state = {f"transformer.{k}": v.detach().half().contiguous().cpu() for k, v in model.state_dict().items() if not k.endswith("freqs_cis")}
    tmp = path.with_suffix(".tmp")
    save_file(state, str(tmp))
    tmp.replace(path)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--id", required=True, help="voice id, used in the output file name")
    p.add_argument("--hours", type=float, default=2.5)
    p.add_argument("--lr", type=float, default=1e-5)
    p.add_argument("--max-frames", type=int, default=3200, help="audio frames per batch (T4 16 GB: about 3200)")
    p.add_argument("--max-steps", type=int, default=0, help="Tests: stop after this many steps")
    p.add_argument("--random", type=int, default=0, help="Tests: random model with this many layers")
    args = p.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    torch.manual_seed(0)
    rng = random.Random(0)

    if args.random:
        vocab = [" ", ",", "."] + [chr(c) for c in range(0x0C00, 0x0C80)]
        dit = build_dit(F5Config(depth=args.random, vocab_size=len(vocab)))
        vocos = build_vocos_24khz()
    else:
        from swaram_edge.export import fetch_indicf5

        ckpt, vocab_path = fetch_indicf5()
        vocab = read_vocab(vocab_path)
        dit, _ = load_dit(ckpt, len(vocab))
        vocos = load_vocos()

    from f5_tts.model.cfm import CFM

    cfm = CFM(transformer=dit, vocab_char_map={c: i for i, c in enumerate(vocab)}).to(device)
    mel_enc = MelEncoder().to(device).eval()
    clips = load_clips(Path(args.data), mel_enc, device)
    minutes = sum(m.shape[0] for m, _ in clips) * HOP / SR / 60
    print(f"{len(clips)} recordings, {minutes:.1f} minutes", flush=True)
    assert clips, "No usable recordings (each must be 1-20 seconds with its words)."

    ema = {k: v.detach().clone().float() for k, v in dit.state_dict().items()}
    opt = torch.optim.AdamW([q for q in cfm.parameters() if q.requires_grad], lr=args.lr, weight_decay=0.01)
    use_amp = device == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)
    warmup = 200
    deadline = time.time() + args.hours * 3600
    step, last_save, t0, losses = 0, time.time(), time.time(), []
    target = out / f"voice-model-{args.id}.safetensors"
    cfm.train()
    while True:
        for batch in batches(clips, args.max_frames, rng):
            mels = [clips[i][0] for i in batch]
            lens = torch.tensor([m.shape[0] for m in mels], device=device)
            x = torch.zeros(len(mels), int(lens.max()), mels[0].shape[1])
            for j, m in enumerate(mels):
                x[j, : m.shape[0]] = m
            x = x.to(device)
            texts = [clips[i][1] for i in batch]
            for g in opt.param_groups:
                g["lr"] = args.lr * min(1.0, (step + 1) / warmup)
            with torch.autocast("cuda", dtype=torch.float16, enabled=use_amp):
                loss, _, _ = cfm(x, texts, lens=lens)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(cfm.parameters(), 1.0)
            scaler.step(opt)
            scaler.update()
            step += 1
            # Averaged weights: steadier than the latest step, what gets saved.
            decay = min(0.999, (1 + step) / (10 + step))
            with torch.no_grad():
                for k, v in dit.state_dict().items():
                    if v.dtype.is_floating_point:
                        ema[k].mul_(decay).add_(v.float(), alpha=1 - decay)
            if math.isfinite(loss.item()):
                losses.append(loss.item())
            if step % 50 == 0:
                rate = (time.time() - t0) / step
                print(f"step {step} loss {np.mean(losses[-50:]):.4f} {rate:.2f} s/step", flush=True)
            done = time.time() > deadline or (args.max_steps and step >= args.max_steps)
            if done or time.time() - last_save > 1800:
                live = {k: v.clone() for k, v in dit.state_dict().items()}
                dit.load_state_dict({k: ema[k].to(live[k].dtype) for k in live}, strict=False)
                save_weights(dit, target)
                dit.load_state_dict(live, strict=False)
                last_save = time.time()
                print(f"saved {target.name} at step {step}", flush=True)
            if done:
                break
        else:
            continue
        break

    # A sample with the trained model, reading a new line in the first recording's voice.
    dit.load_state_dict({k: ema[k].to(v.dtype) for k, v in dit.state_dict().items()}, strict=False)
    cfm.eval()
    vocos = vocos.to(device).eval()
    ref_mel, ref_text = clips[0]
    ref_text = normalize_ref_text(ref_text)
    text = "నమస్కారం! ఇది నా కొత్త స్టూడియో వాయిస్. ఇప్పుడు ఇది నాలాగే మాట్లాడుతుంది."
    frames = ref_mel.shape[0]
    dur = min(frames + int(frames / max(1, len(ref_text.encode())) * len(text.encode())), 4096)
    with torch.no_grad():
        mel, _ = cfm.sample(cond=ref_mel[None].to(device), text=[ref_text + text], duration=torch.tensor([dur], device=device),
                            lens=torch.tensor([frames], device=device), steps=32, cfg_strength=2.0, sway_sampling_coef=-1.0)
        wav = vocos.decode(mel[:, frames:dur].float().permute(0, 2, 1))[0].float().cpu().numpy()
    sf.write(out / "sample.wav", np.clip(wav, -1, 1), SR)
    print(f"Done: {step} steps, {(time.time() - t0) / 3600:.2f} h, final loss {np.mean(losses[-100:]):.4f}")


if __name__ == "__main__":
    main()
