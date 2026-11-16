"""Studio voices on the server: link the fine-tuned weights to a profile and
speak through them. Real f5_tts/vocos code, tiny random weights, CPU only."""

import asyncio
import shutil
import tempfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

pytest.importorskip("f5_tts")
pytest.importorskip("vocos")
torch = pytest.importorskip("torch")

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from backend.backends import (  # noqa: E402
    f5_fast,
    indicf5_direct as direct,
)
from backend.tests.test_indicf5_direct import VOCAB, fake_hub  # noqa: E402, F401 - shared fixture


def _studio_checkpoint(path: Path, seed: int) -> Path:
    """A Studio voice file as cloud/finetune.py writes it: transformer.* in half precision."""
    from safetensors.torch import save_file

    direct._install_trainer_stub()
    from f5_tts.model.backbones.dit import DiT

    torch.manual_seed(seed)
    dit = DiT(**direct.DIT_KWARGS, depth=2, mel_dim=100, text_num_embeds=len(VOCAB))
    state = {
        f"transformer.{k}": v.detach().half().contiguous()
        for k, v in dit.state_dict().items()
        if not k.endswith("freqs_cis")
    }
    save_file(state, str(path))
    return path


@pytest.fixture
def server(tmp_path, monkeypatch):
    from backend import config
    from backend.database import Base

    previous = config.get_data_dir()
    config.set_data_dir(tmp_path / "data")
    temp_dir = tempfile.mkdtemp()
    engine = create_engine(f"sqlite:///{Path(temp_dir) / 'test.db'}")
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(autocommit=False, autoflush=False, bind=engine)()
    yield db
    db.close()
    engine.dispose()
    shutil.rmtree(temp_dir)
    config.set_data_dir(previous)


def _profile_with_clip(db, tmp_path):
    from backend.models import VoiceProfileCreate
    from backend.services import profiles

    clip = tmp_path / "ref.wav"
    t = np.arange(24000 * 3) / 24000
    sf.write(clip, (0.3 * np.sin(2 * np.pi * 200 * t)).astype(np.float32), 24000)
    p = asyncio.run(
        profiles.create_profile(
            VoiceProfileCreate(name="Datta", language="te", voice_type="cloned", default_engine="indicf5"), db
        )
    )
    asyncio.run(profiles.add_profile_sample(p.id, str(clip), "నమస్కారం", db))
    return p


def test_link_adds_checkpoint_to_indicf5_prompt_only(server, tmp_path, fake_hub):  # noqa: F811
    from backend.services import profiles, studio_voices

    p = _profile_with_clip(server, tmp_path)
    plain = asyncio.run(profiles.create_voice_prompt_for_profile(p.id, server, engine="indicf5"))
    assert "checkpoint" not in plain

    ckpt = _studio_checkpoint(tmp_path / "voice-model-abc.safetensors", seed=5)
    stored = studio_voices.link(p.id, ckpt)
    assert stored.parent.name == "studio_voices"
    linked = asyncio.run(profiles.create_voice_prompt_for_profile(p.id, server, engine="indicf5"))
    assert linked["checkpoint"] == str(stored)
    assert linked["ref_text"] == plain["ref_text"]

    studio_voices.unlink(p.id)
    again = asyncio.run(profiles.create_voice_prompt_for_profile(p.id, server, engine="indicf5"))
    assert "checkpoint" not in again


def test_backend_speaks_with_the_studio_weights(server, tmp_path, fake_hub, monkeypatch):  # noqa: F811
    from backend.backends import indicf5_backend as ib
    from backend.services import profiles, studio_voices

    monkeypatch.setattr(f5_fast, "quality_steps", lambda quality=None: 2)
    p = _profile_with_clip(server, tmp_path)
    studio_voices.link(p.id, _studio_checkpoint(tmp_path / "voice-model-xyz.safetensors", seed=9))
    prompt = asyncio.run(profiles.create_voice_prompt_for_profile(p.id, server, engine="indicf5"))

    backend = ib.IndicF5Backend()
    monkeypatch.setattr(backend, "_get_device", lambda: "cpu")
    audio, sr = asyncio.run(backend.generate("ఎలా ఉన్నారు?", prompt, language="te"))
    assert sr == 24000
    assert audio.size > 0
    assert np.isfinite(audio).all()
    # The Studio model is loaded, separate from the base one, and its weights differ.
    path, studio = backend._studio
    assert path == prompt["checkpoint"]
    base_w = backend.model.ema_model.transformer.text_embed.text_embed.weight
    studio_w = studio.transformer.text_embed.text_embed.weight
    assert not torch.allclose(base_w.float(), studio_w.float())


def test_cli_links_a_file_and_sets_indicf5(server, tmp_path, monkeypatch, capsys):
    from backend.services import studio_voices
    from backend.tools import studio_voice

    p = _profile_with_clip(server, tmp_path)
    ckpt = _studio_checkpoint(tmp_path / "voice-model-cli.safetensors", seed=2)
    monkeypatch.setattr("backend.database.init_db", lambda: None)
    monkeypatch.setattr("backend.database.get_db", lambda: iter([server]))
    monkeypatch.setattr(server, "close", lambda: None)
    monkeypatch.setattr("sys.argv", ["studio_voice", "--profile", "Datta", "--file", str(ckpt)])
    studio_voice.main()
    assert "now uses the Studio voice" in capsys.readouterr().out
    assert studio_voices.checkpoint_for(p.id) is not None


def test_legacy_kaggle_key_uses_basic_auth():
    from backend.services.studio_voices import _kaggle_headers

    assert _kaggle_headers("a" * 32, "someone")["Authorization"].startswith("Basic ")
    assert _kaggle_headers("KGAT_abc", None)["Authorization"] == "Bearer KGAT_abc"
    with pytest.raises(ValueError, match="username"):
        _kaggle_headers("b" * 32, None)


def test_broken_training_output_is_refused(server, tmp_path):
    """A run that diverged saves NaN weights; linking or loading one must fail clearly."""
    from safetensors.torch import load_file, save_file

    from backend.services import studio_voices

    p = _profile_with_clip(server, tmp_path)
    good = _studio_checkpoint(tmp_path / "voice-model-good.safetensors", seed=3)
    state = {k: torch.full_like(v, float("nan")) for k, v in load_file(str(good)).items()}
    bad = tmp_path / "voice-model-nan.safetensors"
    save_file(state, str(bad))
    with pytest.raises(ValueError, match="broken"):
        studio_voices.link(p.id, bad)
    assert studio_voices.checkpoint_for(p.id) is None
    with pytest.raises(ValueError, match="Train the Studio voice again"):
        direct.load_studio_cfm(bad, VOCAB)
