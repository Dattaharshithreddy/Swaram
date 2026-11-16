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


def all_finite(tensors) -> bool:
    return all(bool(torch.isfinite(v).all()) for v in tensors if v.is_floating_point())


def save_weights(model: torch.nn.Module, path: Path) -> None:
    from safetensors.torch import save_file

    state = {f"transformer.{k}": v.detach().half().contiguous().cpu() for k, v in model.state_dict().items() if not k.endswith("freqs_cis")}
    # Never write a broken model (an earlier run saved NaN weights after 2.5 hours).
    if not all_finite(state.values()):
        raise RuntimeError("The trained weights are not finite (or overflow half precision); not saving them.")
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
    p.add_argument("--max-frames", type=int, default=0, help="audio frames per batch (0: 3200 in half precision, 2000 in fp32, for a 16 GB GPU)")
    p.add_argument("--max-steps", type=int, default=0, help="Tests: stop after this many steps")
    p.add_argument("--random", type=int, default=0, help="Tests: random model with this many layers")
    p.add_argument("--precision", choices=["auto", "fp32", "bf16", "fp16"], default="auto",
                   help="auto: bf16 on GPUs that have it (L4, A100), else fp32. fp16 diverged on a T4.")
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
    params = [q for q in cfm.parameters() if q.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.01)
    precision = args.precision
    if precision == "auto":
        precision = "bf16" if device == "cuda" and torch.cuda.is_bf16_supported() and torch.cuda.get_device_capability()[0] >= 8 else "fp32"
    if device != "cuda":
        precision = "fp32"
    amp_dtype = {"bf16": torch.bfloat16, "fp16": torch.float16}.get(precision)
    scaler = torch.amp.GradScaler("cuda", enabled=precision == "fp16")
    max_frames = args.max_frames or (2000 if precision == "fp32" else 3200)
    print(f"precision {precision}, {max_frames} frames per batch", flush=True)
    lr = args.lr
    warmup = 500
    deadline = time.time() + args.hours * 3600
    step, last_save, t0, losses = 0, time.time(), time.time(), []
    skipped, rollbacks = 0, 0
    target = out / f"voice-model-{args.id}.safetensors"

    def snapshot():
        return ({k: v.detach().cpu().clone() for k, v in dit.state_dict().items()}, {k: v.cpu().clone() for k, v in ema.items()})

    state = {"good": snapshot()}  # last weights known to be healthy, to roll back to
    bad_run = 0

    def check_health():
        nonlocal ema, opt, lr, rollbacks, deadline
        if all_finite(params) and all_finite(ema.values()):
            state["good"] = snapshot()
            return
        # The model blew up: go back to the last healthy weights, learn more slowly.
        rollbacks += 1
        live, ema_good = state["good"]
        dit.load_state_dict(live, strict=False)
        ema = {k: v.to(device) for k, v in ema_good.items()}
        lr /= 2
        opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.01)
        print(f"step {step}: weights went NaN; rolled back, learning rate now {lr:.1e}", flush=True)
        if rollbacks > 4:
            print("Training keeps blowing up; stopping with the last healthy weights.", flush=True)
            deadline = 0

    cfm.train()
    while True:
        for batch in batches(clips, max_frames, rng):
            mels = [clips[i][0] for i in batch]
            lens = torch.tensor([m.shape[0] for m in mels], device=device)
            x = torch.zeros(len(mels), int(lens.max()), mels[0].shape[1])
            for j, m in enumerate(mels):
                x[j, : m.shape[0]] = m
            x = x.to(device)
            texts = [clips[i][1] for i in batch]
            for g in opt.param_groups:
                g["lr"] = lr * min(1.0, (step + 1) / warmup)
            with torch.autocast("cuda", dtype=amp_dtype or torch.float32, enabled=amp_dtype is not None):
                loss, _, _ = cfm(x, texts, lens=lens)
            opt.zero_grad(set_to_none=True)
            bad = not math.isfinite(loss.item())
            if not bad:
                scaler.scale(loss).backward()
                scaler.unscale_(opt)
                norm = torch.nn.utils.clip_grad_norm_(params, 1.0)
                bad = not math.isfinite(float(norm))
                if bad:
                    opt.zero_grad(set_to_none=True)
                    scaler.update()
            if bad:
                # A bad batch: skip it rather than learn from it. Many in a row
                # means the weights themselves broke.
                skipped += 1
                bad_run += 1
                if bad_run >= 10:
                    check_health()
                    bad_run = 0
                if time.time() > deadline:
                    break
                continue
            bad_run = 0
            scaler.step(opt)
            scaler.update()
            step += 1
            # Averaged weights: steadier than the latest step, what gets saved.
            decay = min(0.999, (1 + step) / (10 + step))
            with torch.no_grad():
                for k, v in dit.state_dict().items():
                    if v.dtype.is_floating_point:
                        ema[k].mul_(decay).add_(v.float(), alpha=1 - decay)
            losses.append(loss.item())
            if step % 50 == 0:
                check_health()
                rate = (time.time() - t0) / step
                print(f"step {step} loss {np.mean(losses[-50:]):.4f} {rate:.2f} s/step skipped {skipped}", flush=True)
            done = time.time() > deadline or (args.max_steps and step >= args.max_steps)
            if not done and time.time() - last_save > 1800:  # a copy in case the run is cut off
                live = {k: v.clone() for k, v in dit.state_dict().items()}
                if all_finite(ema.values()):
                    dit.load_state_dict({k: ema[k].to(live[k].dtype) for k in live}, strict=False)
                    save_weights(dit, target)
                    print(f"saved {target.name} at step {step}", flush=True)
                dit.load_state_dict(live, strict=False)
                last_save = time.time()
            if done:
                break
        else:
            continue
        break

    # Save the averaged weights, or the last healthy ones if they broke at the end.
    if not all_finite(ema.values()):
        ema = {k: v.to(device) for k, v in state["good"][1].items()}
    live = dit.state_dict()
    dit.load_state_dict({k: ema[k].to(live[k].dtype) for k in live}, strict=False)
    save_weights(dit, target)
    print(f"saved {target.name} at step {step}", flush=True)
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
    sf.write(out / "sample.wav", np.clip(np.nan_to_num(wav), -1, 1), SR)
    print(f"Done: {step} steps, {(time.time() - t0) / 3600:.2f} h, final loss {np.mean(losses[-100:]):.4f}, "
          f"skipped {skipped} bad batches, {rollbacks} rollbacks")
    # Speech sits well below full scale; silence or full-scale noise means a broken model.
    rms = float(np.sqrt(np.mean(np.nan_to_num(wav) ** 2))) if wav.size else 0.0
    if not args.random and not (np.isfinite(wav).all() and 0.005 < rms < 0.5):
        raise SystemExit(f"The trained voice sounds broken (sample loudness {rms:.3f}); not using it.")


if __name__ == "__main__":
    main()
