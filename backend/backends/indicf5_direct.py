"""
Load IndicF5 straight from its checkpoint, without its Hugging Face wrapper.

The wrapper (``AutoModel.from_pretrained("ai4bharat/IndicF5",
trust_remote_code=True)``) builds the vocoder inside ``__init__``. Recent
transformers versions construct models on the "meta" device first, so that
vocoder has no real weights and ``.to(device)`` fails (seen on a real GPU
server: the first generation crashed in ``load_vocoder``).

This module does what the Kaggle render (``cloud/render.py``, via
``edge/swaram_edge``) already does successfully: download the checkpoint and
vocab, build the DiT + CFM from ``f5_tts``, and load Vocos weights directly.
The result exposes ``ema_model`` and ``vocoder``, the two attributes the fast
path in ``f5_fast.py`` uses.
"""

from __future__ import annotations

import logging
import sys
import types
from pathlib import Path

logger = logging.getLogger(__name__)

INDICF5_REPO = "ai4bharat/IndicF5"
VOCOS_REPO = "charactr/vocos-mel-24khz"

# F5TTS_Base, which IndicF5 uses (depth is read from the checkpoint).
DIT_KWARGS = {"dim": 1024, "heads": 16, "dim_head": 64, "ff_mult": 2, "text_dim": 512, "conv_layers": 4}


class IndicF5Direct:
    """Holds the loaded model pieces; the fast path drives them directly."""

    def __init__(self, ema_model, vocoder, vocab: list[str] | None = None):
        self.ema_model = ema_model
        self.vocoder = vocoder
        self.vocab = vocab or []

    def to(self, device):
        self.ema_model = self.ema_model.to(device)
        self.vocoder = self.vocoder.to(device)
        return self

    def eval(self):
        self.ema_model.eval()
        self.vocoder.eval()
        return self


def _install_trainer_stub() -> None:
    """f5_tts.model imports its trainer (wandb, datasets, accelerate) eagerly."""
    name = "f5_tts.model.trainer"
    if name not in sys.modules:
        stub = types.ModuleType(name)
        stub.Trainer = object
        sys.modules[name] = stub


def _find(root: Path, patterns: tuple[str, ...]) -> Path:
    for pattern in patterns:
        hits = sorted(root.rglob(pattern))
        if hits:
            return hits[0]
    raise FileNotFoundError(f"None of {patterns} found under {root}")


def read_vocab(path: str | Path) -> list[str]:
    """One token per line, as F5-TTS writes vocab.txt (line order = id)."""
    with open(path, encoding="utf-8") as f:
        return [line.rstrip("\n") for line in f]


def transformer_state(state: dict) -> dict:
    """The DiT weights from an F5/IndicF5 checkpoint, EMA weights preferred."""
    if "ema_model_state_dict" in state:
        state = state["ema_model_state_dict"]
    elif "model_state_dict" in state:
        state = state["model_state_dict"]
    ema = {k: v for k, v in state.items() if k.startswith("ema_model.")}
    if ema:
        state = ema
    out = {}
    for key, value in state.items():
        if "transformer." in key:
            out[key.split("transformer.", 1)[1]] = value
    if not out:
        raise ValueError("No transformer weights found in the IndicF5 checkpoint")
    return out


def _load_state(path: Path) -> dict:
    if path.suffix == ".safetensors":
        from safetensors.torch import load_file

        return load_file(str(path))
    import torch

    return torch.load(str(path), map_location="cpu", weights_only=True)


def build_cfm(state: dict, vocab: list[str]):
    """DiT + CFM sized from the checkpoint, with its weights loaded."""
    _install_trainer_stub()
    from f5_tts.model.backbones.dit import DiT
    from f5_tts.model.cfm import CFM

    rows = state["text_embed.text_embed.weight"].shape[0]  # vocab + 1 filler row
    depth = 1 + max(int(k.split(".")[1]) for k in state if k.startswith("transformer_blocks."))
    if rows - 1 != len(vocab):
        logger.info("IndicF5 checkpoint has %d text tokens, vocab file has %d", rows - 1, len(vocab))
    dit = DiT(**DIT_KWARGS, depth=depth, mel_dim=100, text_num_embeds=rows - 1)
    missing, unexpected = dit.load_state_dict(state, strict=False)
    missing = [k for k in missing if not k.endswith("freqs_cis")]
    if missing or unexpected:
        raise ValueError(f"IndicF5 checkpoint mismatch. missing={missing[:5]} unexpected={unexpected[:5]}")
    vocab_map = {c: i for i, c in enumerate(vocab)}
    return CFM(transformer=dit, vocab_char_map=vocab_map).eval()


def build_vocos(weights: str | Path):
    """Vocos (vocos-mel-24khz) with its trained weights."""
    import torch
    from vocos import Vocos
    from vocos.feature_extractors import MelSpectrogramFeatures
    from vocos.heads import ISTFTHead
    from vocos.models import VocosBackbone

    model = Vocos(
        feature_extractor=MelSpectrogramFeatures(
            sample_rate=24000, n_fft=1024, hop_length=256, n_mels=100, padding="center"
        ),
        backbone=VocosBackbone(input_channels=100, dim=512, intermediate_dim=1536, num_layers=8),
        head=ISTFTHead(dim=512, n_fft=1024, hop_length=256, padding="same"),
    )
    state = torch.load(str(weights), map_location="cpu", weights_only=True)
    state = {k: v for k, v in state.items() if not k.startswith("feature_extractor.")}
    missing, unexpected = model.load_state_dict(state, strict=False)
    missing = [k for k in missing if not k.startswith("feature_extractor.")]
    if missing or unexpected:
        raise ValueError(f"Vocos weights mismatch. missing={missing[:5]} unexpected={unexpected[:5]}")
    return model.eval()


def load_indicf5() -> IndicF5Direct:
    """Download (or reuse) IndicF5 + Vocos and build them on the CPU."""
    from huggingface_hub import hf_hub_download, snapshot_download

    snapshot = Path(
        snapshot_download(INDICF5_REPO, allow_patterns=["*.safetensors", "*.pt", "*.txt", "*.json", "*.py"])
    )
    ckpt = _find(snapshot, ("model.safetensors", "*.safetensors", "*.pt"))
    vocab = read_vocab(_find(snapshot, ("vocab.txt", "*vocab*.txt")))
    cfm = build_cfm(transformer_state(_load_state(ckpt)), vocab)
    vocoder = build_vocos(hf_hub_download(VOCOS_REPO, "pytorch_model.bin"))
    logger.info("IndicF5 loaded directly from %s (%d tokens)", ckpt.name, len(vocab))
    return IndicF5Direct(cfm, vocoder, vocab)


def load_studio_cfm(checkpoint: str | Path, vocab: list[str]):
    """A Studio voice: IndicF5's transformer fine-tuned on one person (cloud/finetune.py)."""
    state = transformer_state(_load_state(Path(checkpoint)))
    state = {k: v.float() for k, v in state.items()}  # saved in half precision
    return build_cfm(state, vocab)
