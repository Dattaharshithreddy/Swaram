"""Phones record AAC in .m4a; soundfile can't read it and recent librosa no
longer falls back to audioread, so load_audio decodes with ffmpeg."""

import shutil
import subprocess

import numpy as np
import pytest

from backend.utils.audio import load_audio, validate_and_load_reference_audio

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


@pytest.fixture
def phone_clip(tmp_path):
    path = tmp_path / "recording.m4a"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=4",
         "-c:a", "aac", "-b:a", "96k", str(path)],
        check=True,
    )
    return path


def test_load_audio_reads_m4a(phone_clip):
    audio, sr = load_audio(str(phone_clip), sample_rate=24000)
    assert sr == 24000
    assert audio.dtype == np.float32
    assert 3.8 < len(audio) / sr < 4.3
    assert np.sqrt(np.mean(audio**2)) > 0.05


def test_reference_validation_accepts_m4a(phone_clip):
    ok, err, audio, _sr = validate_and_load_reference_audio(str(phone_clip))
    assert ok, err
    assert audio is not None


def test_unreadable_file_still_errors(tmp_path):
    bad = tmp_path / "x.m4a"
    bad.write_bytes(b"not audio")
    with pytest.raises(ValueError, match="Could not read this audio file"):
        load_audio(str(bad))
