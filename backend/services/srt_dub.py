"""
Subtitle-timed dubbing: turn a translated .srt file into one audio track.

Workflow this supports (a typical Telugu dub of an English video):

1. Export the English subtitles of the video (YouTube Studio, Whisper, ...).
2. Translate each cue into Telugu and proofread it, keeping the timestamps.
3. POST the Telugu .srt with a cloned voice profile to ``/dub/srt``.
4. Get back a WAV that lines up with the video: each cue starts at its
   timestamp and is sped up slightly when it runs longer than the original.
   Upload it to YouTube as an additional audio track, or mux it with ffmpeg.

The pure functions here (parsing, fitting, mixing) carry no model imports so
they can be unit-tested without torch.
"""

from __future__ import annotations

import io
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

import numpy as np

logger = logging.getLogger(__name__)

DEFAULT_MAX_SPEEDUP = 1.25
MAX_ALLOWED_SPEEDUP = 1.6
TAIL_SECONDS = 1.0

_TIME_RE = re.compile(r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})")
_TAG_RE = re.compile(r"<[^>]+>|\{\\[^}]*\}")


@dataclass
class Cue:
    index: int
    start: float
    end: float
    text: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass
class CueResult:
    index: int
    start: float
    end: float
    text: str
    placed_at: float = 0.0
    spoken_seconds: float = 0.0
    speedup: float = 1.0
    overflow_seconds: float = 0.0
    error: str | None = None

    def as_dict(self) -> dict:
        return {
            "index": self.index,
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "text": self.text,
            "placed_at": round(self.placed_at, 3),
            "spoken_seconds": round(self.spoken_seconds, 3),
            "speedup": round(self.speedup, 3),
            "overflow_seconds": round(self.overflow_seconds, 3),
            "error": self.error,
        }


@dataclass
class DubReport:
    sample_rate: int = 24000
    duration_seconds: float = 0.0
    cues: list[CueResult] = field(default_factory=list)

    @property
    def failed(self) -> list[CueResult]:
        return [c for c in self.cues if c.error]

    @property
    def overflowing(self) -> list[CueResult]:
        return [c for c in self.cues if not c.error and c.overflow_seconds > 0.05]

    def summary(self) -> dict:
        return {
            "sample_rate": self.sample_rate,
            "duration_seconds": round(self.duration_seconds, 3),
            "cue_count": len(self.cues),
            "failed_cues": [c.index for c in self.failed],
            "overflowing_cues": [c.index for c in self.overflowing],
            "sped_up_cues": [c.index for c in self.cues if c.speedup > 1.001],
        }


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _seconds(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000


def parse_srt(content: str) -> list[Cue]:
    """Parse SRT text into cues. Tolerates BOMs, CRLF, missing indices,
    ``.`` as the millisecond separator, and formatting tags."""
    content = content.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    cues: list[Cue] = []
    for block in re.split(r"\n\s*\n", content.strip()):
        lines = [ln.strip() for ln in block.split("\n") if ln.strip()]
        time_line = next((i for i, ln in enumerate(lines) if _TIME_RE.search(ln)), None)
        if time_line is None:
            continue
        m = _TIME_RE.search(lines[time_line])
        start = _seconds(*m.groups()[:4])
        end = _seconds(*m.groups()[4:])
        text = " ".join(_TAG_RE.sub("", ln) for ln in lines[time_line + 1 :]).strip()
        if not text:
            continue
        index = len(cues) + 1
        if time_line > 0 and lines[time_line - 1].isdigit():
            index = int(lines[time_line - 1])
        if end <= start:
            raise ValueError(f"Cue {index} ends before it starts")
        cues.append(Cue(index=index, start=start, end=end, text=text))
    if not cues:
        raise ValueError("No subtitle cues found. Is this a valid .srt file?")
    cues.sort(key=lambda c: c.start)
    return cues


def format_timestamp(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# ---------------------------------------------------------------------------
# Fitting and mixing
# ---------------------------------------------------------------------------


def trim_silence(audio: np.ndarray, sample_rate: int, threshold: float = 0.01) -> np.ndarray:
    """Drop leading/trailing near-silence so cue timing is tight."""
    if audio.size == 0:
        return audio
    loud = np.flatnonzero(np.abs(audio) > threshold)
    if loud.size == 0:
        return audio[:0]
    pad = int(0.03 * sample_rate)
    return audio[max(0, loud[0] - pad) : min(audio.size, loud[-1] + pad)]


def fit_to_duration(
    audio: np.ndarray,
    sample_rate: int,
    target_seconds: float,
    max_speedup: float = DEFAULT_MAX_SPEEDUP,
) -> tuple[np.ndarray, float]:
    """Speed audio up (pitch preserved) so it fits ``target_seconds``.

    Never speeds up by more than ``max_speedup``; never slows down.
    Returns ``(audio, speedup_applied)``.
    """
    if audio.size == 0 or target_seconds <= 0:
        return audio, 1.0
    length = audio.size / sample_rate
    if length <= target_seconds:
        return audio, 1.0
    rate = min(length / target_seconds, max_speedup)
    if rate <= 1.001:
        return audio, 1.0
    import librosa

    stretched = librosa.effects.time_stretch(audio.astype(np.float32), rate=rate)
    return stretched.astype(np.float32), rate


def mix_cues(
    clips: list[tuple[CueResult, np.ndarray]],
    sample_rate: int,
    min_gap_seconds: float = 0.05,
    min_duration_seconds: float = 0.0,
) -> np.ndarray:
    """Place clips on one timeline at their cue starts.

    A clip that would overlap the previous one is pushed later instead of
    talking over it; ``placed_at`` and ``overflow_seconds`` on each result
    record what happened. ``min_duration_seconds`` keeps the track at
    least as long as the subtitles even when the last cues failed, so it
    still lines up with the video.
    """
    cursor = 0.0
    placements: list[tuple[int, np.ndarray]] = []
    for result, clip in clips:
        start = max(result.start, cursor + (min_gap_seconds if cursor else 0.0))
        result.placed_at = start
        result.spoken_seconds = clip.size / sample_rate
        finish = start + result.spoken_seconds
        result.overflow_seconds = max(0.0, finish - result.end)
        cursor = finish
        placements.append((int(round(start * sample_rate)), clip))

    last_cue_end = max([r.end for r, _ in clips] + [min_duration_seconds])
    total = max(cursor, last_cue_end) + TAIL_SECONDS
    track = np.zeros(int(round(total * sample_rate)), dtype=np.float32)
    for offset, clip in placements:
        track[offset : offset + clip.size] += clip[: max(0, track.size - offset)]
    peak = float(np.max(np.abs(track))) if track.size else 0.0
    if peak > 0.99:
        track *= 0.99 / peak
    return track


def wav_bytes_to_array(data: bytes) -> tuple[np.ndarray, int]:
    import soundfile as sf

    audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return audio.astype(np.float32), int(sr)


def resample(audio: np.ndarray, sr_from: int, sr_to: int) -> np.ndarray:
    if sr_from == sr_to:
        return audio
    import librosa

    return librosa.resample(audio, orig_sr=sr_from, target_sr=sr_to).astype(np.float32)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

Synthesize = Callable[[str], Awaitable[bytes]]


async def dub_cues(
    cues: list[Cue],
    synthesize: Synthesize,
    *,
    max_speedup: float = DEFAULT_MAX_SPEEDUP,
    sample_rate: int = 24000,
    on_progress: Callable[[int, int], None] | None = None,
) -> tuple[np.ndarray, DubReport]:
    """Synthesize every cue with ``synthesize(text) -> wav bytes`` and mix.

    A failing cue is reported and left silent rather than failing the whole
    track, so one bad line does not cost a 20-minute render.
    """
    max_speedup = max(1.0, min(float(max_speedup), MAX_ALLOWED_SPEEDUP))
    report = DubReport(sample_rate=sample_rate)
    clips: list[tuple[CueResult, np.ndarray]] = []

    for n, cue in enumerate(cues, start=1):
        result = CueResult(index=cue.index, start=cue.start, end=cue.end, text=cue.text)
        report.cues.append(result)
        try:
            wav = await synthesize(cue.text)
            audio, sr = wav_bytes_to_array(wav)
            audio = resample(audio, sr, sample_rate)
            audio = trim_silence(audio, sample_rate)
            audio, result.speedup = fit_to_duration(audio, sample_rate, cue.duration, max_speedup)
            clips.append((result, audio))
        except Exception as exc:
            logger.warning("Cue %s failed: %s", cue.index, exc)
            result.error = str(exc) or exc.__class__.__name__
        if on_progress:
            on_progress(n, len(cues))

    track = mix_cues(clips, sample_rate, min_duration_seconds=max(c.end for c in cues))
    report.duration_seconds = track.size / sample_rate
    return track, report


async def dub_srt_with_profile(
    srt_text: str,
    *,
    profile_id: str,
    language: str,
    engine: str,
    model_size: str = "default",
    max_speedup: float = DEFAULT_MAX_SPEEDUP,
    seed: int | None = None,
) -> tuple[np.ndarray, DubReport]:
    """Dub an SRT with a saved voice profile using the normal generation path."""
    from .generation import generate_audio_sync

    cues = parse_srt(srt_text)

    async def synthesize(text: str) -> bytes:
        return await generate_audio_sync(
            profile_id=profile_id,
            text=text,
            language=language,
            engine=engine,
            model_size=model_size,
            seed=seed,
            normalize=True,
        )

    return await dub_cues(cues, synthesize, max_speedup=max_speedup)
