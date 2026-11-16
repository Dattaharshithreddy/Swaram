"""Narration scripts: parsing the marks, joining lines with exact pauses, and
speaking each line from the profile's mood clip."""

import asyncio
import json
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from backend.services import narration as nar

SR = 24000


def test_script_marks_set_mood_pace_and_pauses():
    lines = nar.parse_script(
        "(story) అనగనగా ఒక ఊరు. [pause 0.7]\n"
        "(scared, slow) ఇల్లంతా చీకటి.\n"
        "\n"
        "నానమ్మ నవ్వింది. [pause 1] (happy, speed 1.1) చూడు రాము!\n"
        "(Excited) ఉరుములు! [PAUSE 0.25s]\n"
    )
    assert [(x.text, x.mood, x.speed, x.pause) for x in lines] == [
        ("అనగనగా ఒక ఊరు.", "story", 1.0, 0.7),
        ("ఇల్లంతా చీకటి.", "fear", 0.9, nar.PARAGRAPH_PAUSE),  # blank line after it
        ("నానమ్మ నవ్వింది.", None, 1.0, 1.0),
        ("చూడు రాము!", "happy", 1.1, nar.LINE_PAUSE),
        ("ఉరుములు!", "surprise", 1.0, 0.25),
    ]


def test_script_mistakes_are_explained():
    with pytest.raises(ValueError, match="Unknown mood \\(sleepy\\)"):
        nar.parse_script("(sleepy) హలో")
    with pytest.raises(ValueError, match="no text"):
        nar.parse_script("  \n[pause 1]\n")
    # Brackets that are part of the sentence are spoken, not read as marks.
    assert nar.parse_script("(రాము) వచ్చాడు")[0].text == "(రాము) వచ్చాడు"
    assert nar.parse_script("(speed 9) హలో")[0].speed == nar.SPEED_RANGE[1]


def test_assemble_places_lines_and_fits_a_target_length():
    a, b, c = (np.full(SR * n, 0.1, dtype=np.float32) for n in (2, 1, 3))
    audio, times = nar.assemble([a, b, c], [0.5, 1.0, 0.45], SR)
    assert times == [(0.4, 2.4), (2.9, 3.9), (4.9, 7.9)]
    assert len(audio) / SR == pytest.approx(8.5)
    assert not audio[int(2.5 * SR) : int(2.8 * SR)].any()  # the pause is silence

    longer, times = nar.assemble([a, b, c], [0.5, 1.0, 0.45], SR, target_seconds=9.25)
    assert len(longer) / SR == pytest.approx(9.25)
    assert times[1][0] == pytest.approx(3.15)  # pauses grew 1.5x, speech untouched
    capped, _ = nar.assemble([a, b, c], [0.5, 1.0, 0.45], SR, target_seconds=60)
    assert len(capped) / SR == pytest.approx(6 + 1 + 1.5 * 1.8)


def test_polish_trims_and_levels_a_line():
    t = np.arange(SR) / SR
    quiet = np.concatenate([np.zeros(SR // 2), 0.03 * np.sin(2 * np.pi * 150 * t), np.zeros(SR // 2)])
    out = nar.polish(quiet.astype(np.float32), SR)
    assert 0.95 < len(out) / SR < 1.1
    assert np.sqrt(np.mean(out[SR // 4 : -SR // 4] ** 2)) == pytest.approx(nar.TARGET_LOUDNESS, rel=0.1)
    assert abs(out[0]) < 1e-6
    assert abs(out[-1]) < 1e-6


@pytest.fixture
def data_dir(tmp_path):
    from backend import config

    previous = config.get_data_dir()
    config.set_data_dir(tmp_path / "data")
    yield tmp_path
    config.set_data_dir(previous)


def _clip_folder(folder, texts):
    folder.mkdir()
    for name in texts:
        sf.write(folder / f"{name}.wav", np.zeros(SR, dtype=np.float32), SR)
    (folder / "texts.json").write_text(json.dumps(texts, ensure_ascii=False), "utf-8")
    return folder


def test_mood_clips_install_under_their_mood_names(data_dir):
    src = _clip_folder(data_dir / "src", {"FEAR": "భయం", "BOOK": "కథ", "nonsense": "x", "happy": " "})
    assert nar.install_mood_clips("p1", src) == ["fear", "story"]
    clips = nar.mood_clips("p1")
    assert clips["story"][1] == "కథ"
    assert clips["fear"][0].name == "fear.wav"
    # A second folder adds to what is there.
    assert nar.install_mood_clips("p1", _clip_folder(data_dir / "more", {"sad": "బాధ"})) == ["fear", "sad", "story"]
    assert nar.mood_clips("other") == {}
    nar.remove_mood_clips("p1")
    assert nar.mood_clips("p1") == {}
    with pytest.raises(ValueError, match=r"texts\.json"):
        nar.install_mood_clips("p1", data_dir)


def test_narrate_speaks_each_line_from_its_mood_clip(data_dir, monkeypatch):
    from backend import backends
    from backend.services import profiles

    nar.install_mood_clips("p1", _clip_folder(data_dir / "src", {"story": "కథ", "fear": "భయం"}))
    calls = []

    class FakeIndicF5:
        async def generate(self, text, voice_prompt, language, seed, speed=1.0):
            calls.append((text, voice_prompt["ref_text"], voice_prompt.get("checkpoint"), language, seed, speed))
            t = np.arange(SR) / SR
            return (0.2 * np.sin(2 * np.pi * 180 * t)).astype(np.float32), SR

    async def base_prompt(profile_id, db, use_cache=True, engine=None):
        assert engine == "indicf5"
        return {"format_version": 1, "ref_audio_path": "own.wav", "ref_text": "నా గొంతు", "checkpoint": "me.safetensors"}

    async def loaded(engine, model_size="default"):
        assert engine == "indicf5"

    monkeypatch.setattr(backends, "get_tts_backend_for_engine", lambda engine: FakeIndicF5())
    monkeypatch.setattr(backends, "load_engine_model", loaded)
    monkeypatch.setattr(profiles, "create_voice_prompt_for_profile", base_prompt)

    profile = SimpleNamespace(id="p1", name="Datta", language="te")
    script = "ఒక ఊరు. [pause 1]\n(fear, slow) చీకటి.\n(happy) నవ్వింది."
    res = asyncio.run(nar.narrate(None, profile, script, seed=10))

    assert calls == [
        ("ఒక ఊరు.", "కథ", "me.safetensors", "te", 10, 1.0),  # untagged lines use the story clip
        ("చీకటి.", "భయం", "me.safetensors", "te", 11, 0.9),
        ("నవ్వింది.", "నా గొంతు", "me.safetensors", "te", 12, 1.0),  # no happy clip: the voice's own
    ]
    assert res["moods_available"] == ["fear", "story"]
    assert res["moods_missing"] == ["happy"]
    assert [x["mood"] for x in res["lines"]] == ["story", "fear", "happy"]
    assert res["lines"][1]["start"] == pytest.approx(res["lines"][0]["end"] + 1.0, abs=0.01)
    audio, sr = sf.read(res["audio_path"])
    assert sr == SR
    assert len(audio) / sr == pytest.approx(res["duration"], abs=0.01)
    assert res["audio_path"].endswith(".wav")
    assert "/narrations/narration-" in res["audio_path"]
