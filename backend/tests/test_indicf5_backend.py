"""Tests for the IndicF5 engine wiring, using a fake model (no weights needed)."""

import asyncio

import numpy as np
import pytest
import soundfile as sf

from backend import backends
from backend.backends import indicf5_backend as ib


@pytest.fixture
def cache_dir(tmp_path, monkeypatch):
    from backend import config

    monkeypatch.setattr(config, "get_cache_dir", lambda: tmp_path)
    return tmp_path


@pytest.fixture
def ref_clip(tmp_path):
    path = tmp_path / "ref.wav"
    t = np.arange(16000 * 3) / 16000
    sf.write(path, (0.3 * np.sin(2 * np.pi * 200 * t)).astype(np.float32), 16000)
    return str(path)


class FakeIndicF5:
    def __init__(self):
        self.calls = []

    def __call__(self, text, ref_audio_path, ref_text):
        self.calls.append((text, ref_audio_path, ref_text))
        return (np.ones(2400) * 16384).astype(np.int16)


def test_engine_is_registered_with_indian_languages():
    assert backends.TTS_ENGINES["indicf5"] == "IndicF5"
    cfg = backends.get_model_config("indicf5")
    assert cfg is not None
    assert cfg.engine == "indicf5"
    assert set(cfg.languages) == set(ib.INDICF5_LANGUAGES)
    assert "te" in cfg.languages
    assert "en" not in cfg.languages
    assert isinstance(backends.get_tts_backend_for_engine("indicf5"), ib.IndicF5Backend)


def test_every_engine_language_is_english_or_indian():
    allowed = set(backends.SUPPORTED_LANGUAGES)
    for cfg in backends.get_tts_model_configs():
        assert set(cfg.languages) <= allowed, cfg.model_name


def test_voice_prompt_requires_transcript(cache_dir, ref_clip):
    backend = ib.IndicF5Backend()
    with pytest.raises(ValueError, match="transcript"):
        asyncio.run(backend.create_voice_prompt(ref_clip, "  ", use_cache=False))


def test_voice_prompt_and_generate(cache_dir, ref_clip):
    backend = ib.IndicF5Backend()
    prompt, cached = asyncio.run(backend.create_voice_prompt(ref_clip, "నమస్కారం", use_cache=False))
    assert cached is False
    assert prompt["ref_text"] == "నమస్కారం"
    data, sr = sf.read(prompt["ref_audio_path"])
    assert sr == ib.SAMPLE_RATE
    assert data.ndim == 1

    fake = FakeIndicF5()
    backend.model = fake  # skip the real load
    audio, sr = asyncio.run(backend.generate("ఎలా ఉన్నారు?", prompt, language="te"))
    assert sr == 24000
    assert audio.dtype == np.float32
    assert np.allclose(audio, 0.5)
    assert fake.calls == [("ఎలా ఉన్నారు?", prompt["ref_audio_path"], "నమస్కారం")]


def test_generate_rejects_non_cloned_prompt():
    backend = ib.IndicF5Backend()
    backend.model = FakeIndicF5()
    with pytest.raises(ValueError, match="only clones"):
        asyncio.run(backend.generate("హలో", {}, language="te"))
