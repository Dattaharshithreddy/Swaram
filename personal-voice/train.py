"""Fine-tune Piper's Telugu voice (te_IN-maya-medium) on the generated audio.

    python train.py --data data --piper piper1-gpl --hours 2.5 --out train
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

BASE_REPO = "rhasspy/piper-checkpoints"
BASE_CKPT = "te/te_IN/maya/medium/epoch=3277-step=839202.ckpt"


def base_checkpoint() -> str:
    from huggingface_hub import hf_hub_download

    return hf_hub_download(BASE_REPO, BASE_CKPT, repo_type="dataset")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--piper", required=True, help="piper1-gpl checkout (with the monotonic_align build)")
    p.add_argument("--out", required=True)
    p.add_argument("--hours", type=float, default=2.5)
    p.add_argument("--batch", type=int, default=16)
    p.add_argument("--devices", type=int, default=1, help="GPUs to train on (2 on Kaggle's T4 x2)")
    p.add_argument("--max-steps", type=int, default=0, help="Tests: stop after this many steps (relative)")
    p.add_argument("--cpu", action="store_true")
    p.add_argument("--no-base", action="store_true", help="Tests: start from scratch")
    args = p.parse_args()

    data, out = Path(args.data).resolve(), Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    seconds = int(args.hours * 3600)
    cmd = [
        sys.executable, "-m", "piper.train", "fit",
        "--data.voice_name", "swaram",
        "--data.csv_path", str(data / "metadata.csv"),
        "--data.audio_dir", str(data / "wav"),
        "--model.sample_rate", "22050",
        "--data.espeak_voice", "te",
        "--data.phoneme_type", "text",
        "--data.cache_dir", str(out / "cache"),
        "--data.config_path", str(out / "config.json"),
        "--data.batch_size", str(args.batch),
        "--trainer.default_root_dir", str(out),
        "--trainer.max_time", f"00:{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:00",
        "--trainer.accelerator", "cpu" if args.cpu else "gpu",
        "--trainer.devices", str(args.devices),
        "--trainer.log_every_n_steps", "10",
    ]
    if args.devices > 1:
        # GAN training with manual optimisation: some parameters skip a step.
        cmd += ["--trainer.strategy", "ddp_find_unused_parameters_true"]
    if not args.no_base:
        ckpt = base_checkpoint()
        cmd += ["--ckpt_path", ckpt]
        if args.max_steps:
            # Resumed checkpoints count steps from the base run.
            base_step = int(ckpt.rsplit("step=", 1)[1].split(".")[0])
            cmd += ["--trainer.max_steps", str(base_step + args.max_steps)]
    elif args.max_steps:
        cmd += ["--trainer.max_steps", str(args.max_steps)]
    env = dict(os.environ, PYTHONPATH=f"{Path(args.piper).resolve() / 'src'}:{os.environ.get('PYTHONPATH', '')}")
    print(" ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, env=env)


if __name__ == "__main__":
    main()
