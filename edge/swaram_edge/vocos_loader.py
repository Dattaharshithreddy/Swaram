"""Vocos vocoder (charactr/vocos-mel-24khz), built without the hub helper."""

from __future__ import annotations

from pathlib import Path

import torch

VOCOS_REPO = "charactr/vocos-mel-24khz"


def build_vocos_24khz():
    """The architecture of vocos-mel-24khz, with untrained weights."""
    from vocos import Vocos
    from vocos.feature_extractors import MelSpectrogramFeatures
    from vocos.heads import ISTFTHead
    from vocos.models import VocosBackbone

    return Vocos(
        feature_extractor=MelSpectrogramFeatures(
            sample_rate=24000, n_fft=1024, hop_length=256, n_mels=100, padding="center"
        ),
        backbone=VocosBackbone(input_channels=100, dim=512, intermediate_dim=1536, num_layers=8),
        head=ISTFTHead(dim=512, n_fft=1024, hop_length=256, padding="same"),
    ).eval()


def load_vocos(model_dir: str | Path | None = None):
    """Load trained weights from a local folder with pytorch_model.bin, or the Hub."""
    model = build_vocos_24khz()
    if model_dir is None:
        from huggingface_hub import hf_hub_download

        weights = hf_hub_download(VOCOS_REPO, "pytorch_model.bin")
    else:
        weights = str(Path(model_dir) / "pytorch_model.bin")
    state = torch.load(weights, map_location="cpu", weights_only=True)
    state = {k: v for k, v in state.items() if not k.startswith("feature_extractor.")}
    missing, unexpected = model.load_state_dict(state, strict=False)
    missing = [k for k in missing if not k.startswith("feature_extractor.")]
    if missing or unexpected:
        raise ValueError(f"Vocos weights mismatch. missing={missing[:5]} unexpected={unexpected[:5]}")
    return model
