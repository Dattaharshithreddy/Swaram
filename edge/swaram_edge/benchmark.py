"""Measure how fast the edge graphs run, and write sample audio.

    python -m swaram_edge.benchmark build/edge --ref ref.wav --ref-text "..." \\
        --text "..." --out bench/

Without --ref, uses a synthetic reference (fine for timing; audio is useless).
Prints a table of real-time factor (RTF: seconds of compute per second of
audio; below 1.0 means faster than real time) for each step count and
precision, and writes bench/results.json and one WAV per setting.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import time
from pathlib import Path

import numpy as np

from .runner import SAMPLE_RATE, EdgeTTS

DEFAULT_REF_TEXT = "నమస్కారం, నా పేరు మీకు చెప్తాను. ఈ రోజు వాతావరణం చాలా బాగుంది."
DEFAULT_TEXT = "ఈ వీడియోలో SIP ఎలా పని చేస్తుందో ఒక్కసారి చూద్దాం. ప్రతి నెలా కొంచెం పెట్టుబడి పెడితే, కాలక్రమేణా అది పెద్దదవుతుంది."


def load_wav(path: str) -> np.ndarray:
    import soundfile as sf

    wav, sr = sf.read(path, dtype="float32", always_2d=False)
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    if sr != SAMPLE_RATE:
        import librosa

        wav = librosa.resample(wav, orig_sr=sr, target_sr=SAMPLE_RATE).astype(np.float32)
    return wav


def synthetic_ref(seconds: float = 6.0) -> np.ndarray:
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    f0 = 140 + 30 * np.sin(2 * np.pi * 0.7 * t)
    phase = 2 * np.pi * np.cumsum(f0) / SAMPLE_RATE
    voice = sum(np.sin(k * phase) / k for k in range(1, 12))
    return (0.15 * voice * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t))).astype(np.float32)


def run(model_dir: str, ref: np.ndarray, ref_text: str, text: str, steps_list, precisions, threads, out: Path | None):
    import soundfile as sf

    results = []
    for precision in precisions:
        tts = EdgeTTS(model_dir, int8=(precision == "int8"), threads=threads)
        voice = tts.make_voice(ref, ref_text)
        tts.speak(voice, "నమస్కారం.", steps=2, seed=0)  # warm-up
        for steps in steps_list:
            t0 = time.perf_counter()
            wav, timing = tts.speak(voice, text, steps=steps, seed=0)
            wall = time.perf_counter() - t0
            row = {
                "precision": precision,
                "steps": steps,
                "audio_seconds": round(timing.audio_seconds, 2),
                "total_seconds": round(wall, 2),
                "rtf": round(wall / max(timing.audio_seconds, 1e-6), 3),
                "context_seconds": round(timing.context, 3),
                "steps_seconds": round(timing.steps, 2),
                "per_step_ms": round(1000 * float(np.mean(timing.step_times)), 1),
                "vocoder_seconds": round(timing.vocoder, 3),
                "frames": timing.frames,
            }
            results.append(row)
            print(
                f"{precision:5} steps={steps:2}  audio={row['audio_seconds']:5.2f}s  "
                f"compute={row['total_seconds']:6.2f}s  RTF={row['rtf']:.3f}  "
                f"step={row['per_step_ms']:.0f}ms  vocoder={row['vocoder_seconds']:.2f}s"
            )
            if out:
                sf.write(out / f"{precision}_{steps}steps.wav", wav, SAMPLE_RATE)
    return results


def guidance_study(model_dir: str, ref: np.ndarray, ref_text: str, text: str, steps: int = 8, threads=None) -> list[str]:
    """How much skipping guidance on late steps changes the result, against seed-to-seed variation."""
    tts = EdgeTTS(model_dir, int8=True, threads=threads)
    voice = tts.make_voice(ref, ref_text)
    ref_frames = voice.mel.shape[0]

    def mel(guidance: float, seed: int):
        t0 = time.perf_counter()
        m = tts.speak_chunk(voice, text, steps=steps, guidance=guidance, seed=seed, return_mel=True)
        return m[ref_frames:], time.perf_counter() - t0

    base, base_s = mel(1.0, 0)
    other_seed, _ = mel(1.0, 1)
    seed_gap = float(np.abs(base - other_seed).mean())
    lines = [f"steps={steps}  seed-to-seed mel gap={seed_gap:.3f}  full guidance {base_s:.1f}s"]
    for g in (0.75, 0.6, 0.5, 0.4):
        m, sec = mel(g, 0)
        gap = float(np.abs(base - m).mean())
        lines.append(f"guidance={g:.2f}  mel gap={gap:.3f} ({gap / seed_gap:.0%} of seed gap)  {sec:.1f}s ({sec / base_s:.0%} time)")
    return lines


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("model_dir")
    p.add_argument("--ref", help="Reference clip (any format soundfile reads)")
    p.add_argument("--ref-text", default=DEFAULT_REF_TEXT)
    p.add_argument("--text", default=DEFAULT_TEXT)
    p.add_argument("--steps", default="8,16,32")
    p.add_argument("--precision", default="int8,fp32")
    p.add_argument("--threads", type=int, default=None)
    p.add_argument("--out", help="Folder for WAVs and results.json")
    p.add_argument("--guidance-study", action="store_true", help="Also measure skipping guidance on late steps")
    args = p.parse_args()

    out = Path(args.out) if args.out else None
    if out:
        out.mkdir(parents=True, exist_ok=True)
    ref = load_wav(args.ref) if args.ref else synthetic_ref()
    steps = [int(s) for s in args.steps.split(",")]
    precisions = [s.strip() for s in args.precision.split(",")]
    print(f"CPU: {platform.processor() or platform.machine()}, cores: {os.cpu_count()}, threads: {args.threads or 'auto'}")
    results = run(args.model_dir, ref, args.ref_text, args.text, steps, precisions, args.threads, out)
    if args.guidance_study:
        print("Guidance study (int8):")
        for line in guidance_study(args.model_dir, ref, args.ref_text, args.text, threads=args.threads):
            print("  " + line)
    if out:
        meta = {"machine": platform.machine(), "cpus": os.cpu_count(), "threads": args.threads, "results": results}
        (out / "results.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
