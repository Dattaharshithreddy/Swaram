"""Load IndicF5 (F5-TTS) pieces without its training-only dependencies.

``f5_tts.model`` imports its trainer at package import time, which pulls in
wandb, datasets and accelerate. None of that is needed to run or export the
model, so a stub stands in for the trainer module before the import.
"""

from __future__ import annotations

import json
import sys
import types
from dataclasses import asdict, dataclass
from pathlib import Path

import torch

# F5TTS_Base, which IndicF5 uses.
@dataclass
class F5Config:
    dim: int = 1024
    depth: int = 22
    heads: int = 16
    dim_head: int = 64
    ff_mult: int = 2
    text_dim: int = 512
    conv_layers: int = 4
    mel_dim: int = 100
    vocab_size: int = 2545  # replaced by the real vocab length when loading

    def to_json(self) -> str:
        return json.dumps(asdict(self))


SAMPLE_RATE = 24000
HOP_LENGTH = 256
N_FFT = 1024
WIN_LENGTH = 1024
N_MELS = 100


def _install_trainer_stub() -> None:
    name = "f5_tts.model.trainer"
    if name not in sys.modules:
        stub = types.ModuleType(name)
        stub.Trainer = object
        sys.modules[name] = stub


def build_dit(cfg: F5Config):
    _install_trainer_stub()
    from f5_tts.model.backbones.dit import DiT

    model = DiT(
        dim=cfg.dim,
        depth=cfg.depth,
        heads=cfg.heads,
        dim_head=cfg.dim_head,
        ff_mult=cfg.ff_mult,
        text_dim=cfg.text_dim,
        conv_layers=cfg.conv_layers,
        mel_dim=cfg.mel_dim,
        text_num_embeds=cfg.vocab_size,
    )
    return model.eval()


def read_vocab(path: str | Path) -> list[str]:
    """One token per line, as F5-TTS writes vocab.txt (line order = id)."""
    with open(path, encoding="utf-8") as f:
        return [line.rstrip("\n") for line in f]


def _transformer_state(state: dict) -> dict:
    """Pull the DiT weights out of an F5/IndicF5 checkpoint.

    Checkpoints differ in prefix ("ema_model.transformer.",
    "ema_model._orig_mod.transformer.", "model.transformer.", "transformer.");
    keep whatever follows the last "transformer." and prefer EMA weights.
    """
    if "ema_model_state_dict" in state:
        state = state["ema_model_state_dict"]
    elif "model_state_dict" in state:
        state = state["model_state_dict"]

    ema = {k: v for k, v in state.items() if k.startswith("ema_model.")}
    if ema:
        state = ema

    out = {}
    for key, value in state.items():
        if "transformer." not in key:
            continue
        out[key.split("transformer.", 1)[1]] = value
    if not out:
        raise ValueError("No transformer weights found in the checkpoint")
    return out


def load_checkpoint(path: str | Path) -> dict:
    path = str(path)
    if path.endswith(".safetensors"):
        from safetensors.torch import load_file

        state = load_file(path)
    else:
        state = torch.load(path, map_location="cpu", weights_only=True)
    return _transformer_state(state)


def load_dit(checkpoint: str | Path, vocab_size: int) -> tuple[torch.nn.Module, F5Config]:
    state = load_checkpoint(checkpoint)
    # The text embedding table has vocab_size + 1 rows (row 0 is filler).
    rows = state["text_embed.text_embed.weight"].shape[0]
    cfg = F5Config(vocab_size=rows - 1)
    if rows - 1 != vocab_size:
        print(f"note: checkpoint has {rows - 1} text tokens, vocab file has {vocab_size}")
    model = build_dit(cfg)
    missing, unexpected = model.load_state_dict(state, strict=False)
    missing = [k for k in missing if not k.endswith("freqs_cis")]
    if missing or unexpected:
        raise ValueError(f"Checkpoint mismatch. missing={missing[:5]} unexpected={unexpected[:5]}")
    return model, cfg
