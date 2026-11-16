"""Load IndicF5 without its Hugging Face wrapper and generate through the
batched fast path, using the real f5_tts and vocos code with a tiny random
checkpoint (no download, CPU only)."""

import asyncio

import numpy as np
import pytest
import soundfile as sf

pytest.importorskip("f5_tts")
pytest.importorskip("vocos")
torch = pytest.importorskip("torch")

from backend.backends import (  # noqa: E402
    f5_fast,
    indicf5_direct as direct,
)

VOCAB = [" ", ",", ".", *[chr(c) for c in range(0x0C00, 0x0C80)]]


@pytest.fixture
def fake_hub(tmp_path, monkeypatch):
    """A tiny checkpoint in the IndicF5 layout plus Vocos weights."""
    from safetensors.torch import save_file

    direct._install_trainer_stub()
    from f5_tts.model.backbones.dit import DiT

    torch.manual_seed(0)
    dit = DiT(**direct.DIT_KWARGS, depth=2, mel_dim=100, text_num_embeds=len(VOCAB))
    # IndicF5 stores EMA weights under this prefix.
    state = {f"ema_model._orig_mod.transformer.{k}": v.contiguous() for k, v in dit.state_dict().items()}
    snap = tmp_path / "snapshot"
    snap.mkdir()
    save_file(state, str(snap / "model.safetensors"))
    (snap / "vocab.txt").write_text("\n".join(VOCAB) + "\n", encoding="utf-8")

    vocos_bin = tmp_path / "pytorch_model.bin"
    torch.save(_random_vocos_state(), vocos_bin)

    import huggingface_hub

    files = {
        "model.safetensors": snap / "model.safetensors",
        "checkpoints/vocab.txt": snap / "vocab.txt",
        "pytorch_model.bin": vocos_bin,
    }
    monkeypatch.setattr(huggingface_hub, "hf_hub_download", lambda repo, filename, **k: str(files[filename]))
    return tmp_path


def _random_vocos_state():
    from vocos import Vocos
    from vocos.feature_extractors import MelSpectrogramFeatures
    from vocos.heads import ISTFTHead
    from vocos.models import VocosBackbone

    torch.manual_seed(1)
    model = Vocos(
        feature_extractor=MelSpectrogramFeatures(
            sample_rate=24000, n_fft=1024, hop_length=256, n_mels=100, padding="center"
        ),
        backbone=VocosBackbone(input_channels=100, dim=512, intermediate_dim=1536, num_layers=8),
        head=ISTFTHead(dim=512, n_fft=1024, hop_length=256, padding="same"),
    )
    return model.state_dict()


def test_load_indicf5_builds_real_modules(fake_hub):
    model = direct.load_indicf5()
    assert model.ema_model.transformer.text_embed.text_embed.weight.shape[0] == len(VOCAB) + 1
    assert len(model.ema_model.transformer.transformer_blocks) == 2
    assert hasattr(model.ema_model, "sample")
    assert hasattr(model.vocoder, "decode")
    # The wrapper-free model is not callable: the backend must use the fast path.
    assert not callable(model)


def test_fast_path_generates_with_real_f5_code(fake_hub):
    model = direct.load_indicf5()
    t = np.arange(24000 * 2) / 24000
    ref = f5_fast.prepare_reference((0.3 * np.sin(2 * np.pi * 180 * t)).astype(np.float32), "నమస్కారం")
    text = "మొదటి వాక్యం. రెండవ వాక్యం. మూడవ వాక్యం."
    audio = f5_fast.synthesize(model.ema_model, model.vocoder, ref, text, device="cpu", steps=2, seed=3)
    assert audio.dtype == np.float32
    assert audio.size > 24000 * 0.3
    assert np.isfinite(audio).all()


def test_backend_loads_directly_and_speaks(fake_hub, tmp_path, monkeypatch):
    from backend import config
    from backend.backends import indicf5_backend as ib

    monkeypatch.setattr(config, "get_cache_dir", lambda: tmp_path)
    monkeypatch.setattr(f5_fast, "quality_steps", lambda quality=None: 2)
    clip = tmp_path / "ref.wav"
    t = np.arange(16000 * 3) / 16000
    sf.write(clip, (0.3 * np.sin(2 * np.pi * 200 * t)).astype(np.float32), 16000)

    backend = ib.IndicF5Backend()
    monkeypatch.setattr(backend, "_get_device", lambda: "cpu")
    prompt, _ = asyncio.run(backend.create_voice_prompt(str(clip), "నమస్కారం", use_cache=False))
    audio, sr = asyncio.run(backend.generate("ఎలా ఉన్నారు? 😊", prompt, language="te"))
    assert sr == 24000
    assert audio.size > 0
    assert np.isfinite(audio).all()
    assert isinstance(backend.model, direct.IndicF5Direct)
