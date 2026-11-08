"""Faster IndicF5, the DhVaani and Indic Parler-TTS engines, voice design and
the Swaram MCP tools. Fake models only: no weights, no GPU."""

import asyncio
import shutil
import sys
import tempfile
import textwrap
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
import torch
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend import backends
from backend.backends import f5_fast, indicf5_backend as ib

# ─── text chunking ─────────────────────────────────────────────────────────


def test_chunk_text_splits_on_danda():
    text = "पहला वाक्य है। दूसरा वाक्य है। तीसरा वाक्य है।"
    chunks = f5_fast.chunk_text(text, max_bytes=60)
    assert len(chunks) == 3
    assert all(c.endswith("।") for c in chunks)
    assert all(len(c.encode()) <= 60 for c in chunks)


def test_chunk_text_packs_short_sentences_and_measures_chars():
    text = "One. Two. Three. Four."
    assert f5_fast.chunk_text(text, max_bytes=1000) == ["One. Two. Three. Four."]
    assert f5_fast.chunk_text(text, max_bytes=16, measure=len) == ["One. Two. Three.", "Four."]


def test_chunk_text_falls_back_to_clauses_and_words():
    text = "a" * 10 + ", " + "b" * 10 + " " + "c" * 10
    chunks = f5_fast.chunk_text(text, max_bytes=16)
    assert "".join(chunks).replace(" ", "").replace(",", "") == "a" * 10 + "b" * 10 + "c" * 10
    assert all(len(c) <= 16 for c in chunks)


def test_batches_respect_frame_budget():
    groups = f5_fast._batches([100, 300, 200, 50], max_frames=600)
    assert sorted(i for g in groups for i in g) == [0, 1, 2, 3]
    for g in groups:
        durs = [[100, 300, 200, 50][i] for i in g]
        assert len(g) == 1 or max(durs) * len(g) <= 600


def test_quality_presets(monkeypatch):
    from backend.utils import quality

    monkeypatch.setattr(quality, "_current", None)
    monkeypatch.delenv("SWARAM_QUALITY", raising=False)
    monkeypatch.delenv("SWARAM_INDICF5_QUALITY", raising=False)
    assert quality.get_quality() == "balanced"
    assert f5_fast.quality_steps() == 24
    quality.set_quality("fast")
    assert f5_fast.quality_steps() == 16
    assert f5_fast.quality_steps("studio") == 32
    with pytest.raises(ValueError, match="Quality must be"):
        quality.set_quality("ultra")


# ─── batched F5 synthesis with a fake CFM ──────────────────────────────────


class FakeCFM(torch.nn.Module):
    """Mimics f5_tts CFM.sample: returns (B, max_duration, n_mels)."""

    def __init__(self):
        super().__init__()
        self.w = torch.nn.Parameter(torch.zeros(1))
        self.calls = []

    def mel_spec(self, audio):
        frames = audio.shape[-1] // f5_fast.HOP_LENGTH
        return torch.zeros(audio.shape[0], 100, frames)

    def sample(self, cond, text, duration, *, lens, steps, cfg_strength, sway_sampling_coef, seed):
        self.calls.append({"batch": cond.shape[0], "texts": list(text), "steps": steps, "duration": duration.tolist()})
        return torch.ones(cond.shape[0], int(duration.max()), 100), None


class FakeVocoder:
    def decode(self, mel):
        return torch.full((1, mel.shape[-1] * f5_fast.HOP_LENGTH), 0.25)


def test_synthesize_runs_all_chunks_in_one_batch():
    ref = f5_fast.prepare_reference(0.3 * np.sin(np.linspace(0, 300, 24000 * 3)).astype(np.float32), "నమస్కారం")
    cfm, voc = FakeCFM(), FakeVocoder()
    text = "మొదటి వాక్యం. " * 40  # long enough to need several chunks
    audio = f5_fast.synthesize(cfm, voc, ref, text, device="cpu", steps=16, text_converter=lambda xs: xs)
    assert len(cfm.calls) == 1, "every chunk should go through one batched sample() call"
    call = cfm.calls[0]
    assert call["batch"] > 1
    assert call["steps"] == 16
    assert all(t.startswith(ref.text) for t in call["texts"])
    assert audio.dtype == np.float32
    assert audio.size > 0


def test_indicf5_backend_uses_fast_path(monkeypatch, tmp_path):
    from backend import config

    monkeypatch.setattr(config, "get_cache_dir", lambda: tmp_path)
    clip = tmp_path / "ref.wav"
    sf.write(clip, (0.3 * np.sin(np.linspace(0, 400, 16000 * 3))).astype(np.float32), 16000)

    backend = ib.IndicF5Backend()
    prompt, _ = asyncio.run(backend.create_voice_prompt(str(clip), "నమస్కారం", use_cache=False))

    class Wrapper:
        ema_model = FakeCFM()
        vocoder = FakeVocoder()

        def __call__(self, *a, **k):  # pragma: no cover - must not be used
            raise AssertionError("stock path used")

    backend.model = Wrapper()
    audio, sr = asyncio.run(backend.generate("ఎలా ఉన్నారు?", prompt, language="te"))
    assert sr == 24000
    assert audio.size > 0
    assert len(Wrapper.ema_model.calls) == 1
    # The prepared reference is cached for the next line.
    assert len(backend._ref_cache) == 1


@pytest.fixture(autouse=True)
def f5_tts_stub(monkeypatch):
    """A stand-in ``f5_tts.model.utils.convert_char_to_pinyin`` (identity)."""
    import types

    pkg = types.ModuleType("f5_tts")
    model = types.ModuleType("f5_tts.model")
    utils = types.ModuleType("f5_tts.model.utils")
    utils.convert_char_to_pinyin = lambda xs: xs
    monkeypatch.setitem(sys.modules, "f5_tts", pkg)
    monkeypatch.setitem(sys.modules, "f5_tts.model", model)
    monkeypatch.setitem(sys.modules, "f5_tts.model.utils", utils)


def test_generate_chunked_hands_whole_text_to_batching_engines():
    from backend.utils.chunked_tts import generate_chunked

    class Engine:
        batches_long_text = True

        def __init__(self):
            self.texts = []

        async def generate(self, text, voice_prompt, language, seed, instruct):
            self.texts.append(text)
            return np.zeros(10, dtype=np.float32), 24000

    eng = Engine()
    long_text = "Sentence number one. " * 100
    asyncio.run(generate_chunked(eng, long_text, {}, language="en", max_chunk_chars=200))
    assert len(eng.texts) == 1


# ─── engine registration ──────────────────────────────────────────────────


def test_new_engines_registered():
    assert backends.TTS_ENGINES["dhvaani"] == "DhVaani"
    assert backends.TTS_ENGINES["indic_parler"] == "Indic Parler-TTS"
    assert set(backends.get_model_config("dhvaani").languages) == set(backends.INDIC_LANGUAGES)
    assert "te" in backends.get_model_config("indic-parler-tts").languages
    from backend.backends.dhvaani_backend import DhVaaniBackend
    from backend.backends.indic_parler_backend import IndicParlerBackend

    assert isinstance(backends.get_tts_backend_for_engine("dhvaani"), DhVaaniBackend)
    assert isinstance(backends.get_tts_backend_for_engine("indic_parler"), IndicParlerBackend)
    from backend import models

    assert models.GenerationRequest(profile_id="p", text="x", engine="dhvaani").engine == "dhvaani"


def test_dhvaani_requires_transcript_and_finds_checkpoint(tmp_path, monkeypatch):
    from backend import config
    from backend.backends import dhvaani_backend as db

    monkeypatch.setattr(config, "get_cache_dir", lambda: tmp_path)
    with pytest.raises(ValueError, match="transcript"):
        asyncio.run(db.DhVaaniBackend().create_voice_prompt(str(tmp_path / "x.wav"), " ", use_cache=False))
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "other.pt").write_bytes(b"0")
    (tmp_path / "model.safetensors").write_bytes(b"0")
    assert db._find_checkpoint(tmp_path).name == "model.safetensors"


def test_design_engine_follows_language():
    from backend.services.profiles import default_design_engine

    assert default_design_engine("en") == "qwen_voice_design"
    assert default_design_engine("te") == "indic_parler"


# ─── Indic Parler-TTS ─────────────────────────────────────────────────────


def test_build_description_adds_quality_and_speaker():
    from backend.backends.indic_parler_backend import build_description

    d = build_description("a warm calm storyteller", "te", speaker="Lalitha")
    assert d.startswith("Lalitha's voice:")
    assert "no background noise" in d
    kept = build_description("Rohit speaks fast. Very clear audio.", "hi")
    assert kept == "Rohit speaks fast. Very clear audio."


FAKE_WORKER = textwrap.dedent(
    """
    import json, sys
    import numpy as np, soundfile as sf
    for line in sys.stdin:
        req = json.loads(line)
        if req["op"] == "load":
            out = {"id": req["id"], "ok": True, "device": "cpu", "sample_rate": 16000}
        elif req["op"] == "generate":
            n = len(req["texts"])
            sf.write(req["out"], np.full(1600 * n, 0.1, dtype=np.float32), 16000)
            out = {"id": req["id"], "ok": True, "out": req["out"], "sample_rate": 16000, "seconds": 0.1 * n}
        elif req["op"] == "shutdown":
            print(json.dumps({"id": req["id"], "ok": True}), flush=True); break
        else:
            out = {"id": req["id"], "ok": False, "error": "nope"}
        print("some library noise", flush=True)
        print(json.dumps(out), flush=True)
    """
)


def test_parler_backend_talks_to_worker(tmp_path):
    from backend.backends import indic_parler_backend as ipb

    script = tmp_path / "fake_worker.py"
    script.write_text(FAKE_WORKER)
    backend = ipb.IndicParlerBackend()
    backend._worker = ipb._Worker(sys.executable, script=script)
    try:
        audio, sr = asyncio.run(
            backend.generate(
                "మొదటి వాక్యం. రెండవ వాక్యం.",
                {"voice_type": "designed", "design_prompt": "a calm voice"},
                language="te",
            )
        )
        assert sr == 16000
        assert len(audio) == 1600  # one batched piece for short text
        assert backend.is_loaded()
        with pytest.raises(RuntimeError, match="nope"):
            backend._worker.call("bogus")
    finally:
        backend.unload_model()


# ─── voice design service + MCP tools ─────────────────────────────────────


@pytest.fixture
def test_db(monkeypatch, tmp_path):
    from backend import config
    from backend.database import Base

    temp_dir = tempfile.mkdtemp()
    engine = create_engine(f"sqlite:///{Path(temp_dir) / 'test.db'}")
    Base.metadata.create_all(bind=engine)
    db = sessionmaker(autocommit=False, autoflush=False, bind=engine)()
    monkeypatch.setattr(config, "get_profiles_dir", lambda: tmp_path / "profiles")
    monkeypatch.setattr(config, "get_generations_dir", lambda: tmp_path / "generations")
    yield db
    db.close()
    engine.dispose()
    shutil.rmtree(temp_dir)


@pytest.fixture
def fake_designer(monkeypatch):
    """Replace the design engine's render with a 3 s tone."""
    from backend.services import voice_design

    calls = []

    async def fake_render(engine, text, voice_prompt, language, seed):
        calls.append((engine, voice_prompt.get("design_prompt"), language))
        t = np.arange(24000 * 3) / 24000
        return (0.3 * np.sin(2 * np.pi * 180 * t)).astype(np.float32), 24000, 0.5

    monkeypatch.setattr(voice_design, "_render", fake_render)
    return calls


def test_design_voice_lock_creates_cloned_profile(test_db, fake_designer):
    from backend.database import ProfileSample
    from backend.services import voice_design

    res = asyncio.run(
        voice_design.design_voice(
            test_db, name="Kathaa", description="warm storyteller", language="te", speaker="Lalitha"
        )
    )
    assert res["locked"]
    assert res["engine"] == "indicf5"
    assert res["profile"]["voice_type"] == "cloned"
    assert res["profile"]["default_engine"] == "indicf5"
    assert fake_designer[0][0] == "indic_parler"
    sample = test_db.query(ProfileSample).filter_by(profile_id=res["profile"]["id"]).one()
    assert sample.reference_text == voice_design.SAMPLE_TEXT["te"]


def test_design_voice_unlocked_is_designed(test_db, fake_designer):
    from backend.services import voice_design

    res = asyncio.run(
        voice_design.design_voice(test_db, name="Free", description="bright energetic host", language="hi", lock=False)
    )
    assert res["profile"]["voice_type"] == "designed"
    assert res["profile"]["default_engine"] == "indic_parler"
    assert fake_designer == []  # nothing rendered


def test_mcp_server_exposes_swaram_tools():
    from backend.mcp_server.server import build_mcp_server

    mcp = build_mcp_server()
    tools = asyncio.run(mcp.list_tools()) if hasattr(mcp, "list_tools") else asyncio.run(mcp.get_tools())
    names = {t.name for t in tools} if not isinstance(tools, dict) else set(tools)
    for name in (
        "swaram_voice_design_guide",
        "swaram_preview_voice",
        "swaram_design_voice",
        "swaram_clone_voice",
        "swaram_speak",
        "swaram_get_audio",
        "swaram_compare_engines",
        "swaram_set_quality",
        "swaram_list_voices",
        "voicebox_speak",
    ):
        assert name in names, name
    assert all(len(n) <= 64 and "." not in n for n in names)


def test_rest_preview_then_save_locks_the_chosen_take(test_db, fake_designer):
    """The phone app's flow: POST /indic/design/preview, then /indic/design with preview_id."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.database import ProfileSample, get_db
    from backend.routes.indic import router

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_db] = lambda: test_db
    client = TestClient(app)

    prev = client.post("/indic/design/preview", json={"description": "a warm calm voice", "language": "te"})
    assert prev.status_code == 200, prev.text
    body = prev.json()
    assert body["audio_url"].endswith(body["preview_id"])
    audio = client.get(body["audio_url"])
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/wav"

    saved = client.post(
        "/indic/design",
        json={
            "name": "Ammamma",
            "description": body["description"],
            "language": "te",
            "preview_id": body["preview_id"],
            "lock_engine": "dhvaani",
            "text": body["text"],
        },
    )
    assert saved.status_code == 200, saved.text
    res = saved.json()
    assert res["profile"]["default_engine"] == "dhvaani"
    assert len(fake_designer) == 1  # the preview only; saving reused it
    sample = test_db.query(ProfileSample).filter_by(profile_id=res["profile"]["id"]).one()
    assert sample.reference_text == body["text"]

    bad = client.post(
        "/indic/design",
        json={"name": "X", "description": "y", "language": "te", "preview_id": "../../etc/passwd"},
    )
    assert bad.status_code == 422
