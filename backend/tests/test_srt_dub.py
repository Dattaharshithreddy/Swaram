"""Tests for subtitle-timed dubbing (backend/services/srt_dub.py)."""

import asyncio
import io

import numpy as np
import pytest
import soundfile as sf

from backend.services import srt_dub as sd

SR = 24000

SRT = """﻿1
00:00:01,000 --> 00:00:03,000
<i>నమస్కారం</i> అండీ!

2
00:00:03,500 --> 00:00:04,000
ఈ వీడియోలో

3
00:00:06.000 --> 00:00:08.500
compound interest గురించి
చూద్దాం.
"""


def _tone(seconds: float, sr: int = SR) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def _wav(seconds: float, sr: int = SR) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, _tone(seconds, sr), sr, format="WAV")
    return buf.getvalue()


def test_parse_srt():
    cues = sd.parse_srt(SRT.replace("\n", "\r\n"))
    assert [c.index for c in cues] == [1, 2, 3]
    assert cues[0].start == 1.0 and cues[0].end == 3.0
    assert cues[0].text == "నమస్కారం అండీ!"
    assert cues[2].start == 6.0 and cues[2].text == "compound interest గురించి చూద్దాం."


def test_parse_srt_rejects_empty_and_backwards():
    with pytest.raises(ValueError):
        sd.parse_srt("not subtitles")
    with pytest.raises(ValueError):
        sd.parse_srt("1\n00:00:05,000 --> 00:00:04,000\nబ్యాక్\n")


def test_format_timestamp():
    assert sd.format_timestamp(3725.5) == "01:02:05,500"


def test_fit_to_duration_caps_speedup():
    audio = _tone(2.0)
    same, rate = sd.fit_to_duration(audio, SR, 3.0)
    assert rate == 1.0 and same.size == audio.size

    fitted, rate = sd.fit_to_duration(audio, SR, 1.8, max_speedup=1.25)
    assert rate == pytest.approx(2.0 / 1.8, rel=1e-3)
    assert fitted.size / SR == pytest.approx(1.8, abs=0.05)

    capped, rate = sd.fit_to_duration(audio, SR, 1.0, max_speedup=1.25)
    assert rate == pytest.approx(1.25)
    assert capped.size / SR == pytest.approx(1.6, abs=0.05)


def test_trim_silence():
    audio = np.concatenate([np.zeros(SR), _tone(0.5), np.zeros(SR)])
    trimmed = sd.trim_silence(audio, SR)
    assert 0.5 <= trimmed.size / SR <= 0.6


def test_dub_cues_places_on_timeline_and_reports():
    cues = sd.parse_srt(SRT)
    lengths = {"నమస్కారం అండీ!": 1.5, "ఈ వీడియోలో": 2.0}

    async def synth(text: str) -> bytes:
        if text.startswith("compound"):
            raise RuntimeError("engine fell over")
        return _wav(lengths[text], sr=16000)  # different rate on purpose

    track, report = asyncio.run(sd.dub_cues(cues, synth, max_speedup=1.25))

    assert report.sample_rate == SR
    first, second, third = report.cues
    # first cue fits as-is at 1.0 s
    assert first.speedup == 1.0 and first.placed_at == pytest.approx(1.0)
    # second cue is 0.5 s long; 2.0 s of speech gets the max 1.25x and overflows
    assert second.speedup == pytest.approx(1.25)
    assert second.overflow_seconds > 1.0
    # a failing cue is reported, not fatal
    assert third.error == "engine fell over"
    summary = report.summary()
    assert summary["failed_cues"] == [3]
    assert summary["overflowing_cues"] == [2]
    # audio exists at cue 1's start and the track runs past the last cue end
    assert np.abs(track[int(1.05 * SR) : int(1.4 * SR)]).max() > 0.1
    assert np.abs(track[: int(0.9 * SR)]).max() == 0
    assert report.duration_seconds >= 8.5


def test_mix_cues_pushes_overlapping_clip_later():
    a = sd.CueResult(index=1, start=0.0, end=1.0, text="a")
    b = sd.CueResult(index=2, start=0.5, end=2.0, text="b")
    track = sd.mix_cues([(a, _tone(1.0)), (b, _tone(0.5))], SR)
    assert b.placed_at == pytest.approx(1.05)
    assert track.size / SR == pytest.approx(3.0, abs=0.01)
    assert np.abs(track).max() <= 0.99 + 1e-6
