"""Narration: a marked-up script in, one finished recording out.

    (story) అనగనగా ఒక చిన్న పల్లెటూరు. [pause 0.7]
    (fear, slow) ఇల్లంతా చీకటి.
    (happy) నానమ్మ చిన్నగా నవ్వింది.

Each line is spoken on its own and the lines are joined with pauses, so the
pacing is exact. A ``(mood)`` at the start of a line picks the mood clip the
line is spoken from: IndicF5 copies the delivery of its reference clip, so a
profile with mood clips (``backend.tools.mood_clips``) gets expressive
narration in its own voice. ``slow`` / ``fast`` / ``speed 0.9`` set the pace
and ``[pause 0.8]`` the gap that follows; a blank line is a longer gap.

The result lists when each line starts and ends, for captions.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .. import config

logger = logging.getLogger(__name__)

MOODS = ("story", "talk", "happy", "sad", "fear", "surprise", "anger", "disgust")
ALIASES = {
    "calm": "story", "narration": "story", "narrate": "story", "book": "story",
    "conv": "talk", "conversation": "talk", "casual": "talk",
    "joy": "happy", "warm": "happy",
    "scared": "fear", "afraid": "fear", "tense": "fear",
    "surprised": "surprise", "excited": "surprise", "shock": "surprise",
    "angry": "anger",
    "disgusted": "disgust",
}  # fmt: skip
PACES = {"slow": 0.9, "slower": 0.85, "fast": 1.08, "faster": 1.15}
DEFAULT_MOOD = "story"
LINE_PAUSE = 0.45
PARAGRAPH_PAUSE = 0.9
SPEED_RANGE = (0.7, 1.4)
MAX_PAUSE = 5.0
MAX_LINES = 200
TARGET_LOUDNESS = 0.12  # RMS of the voiced part of every line

_TAG = re.compile(r"^\s*\(([A-Za-z0-9_.,\s]+)\)\s*")
_PAUSE = re.compile(r"\[\s*pause\s*([0-9]*\.?[0-9]+)\s*s?\s*\]", re.IGNORECASE)


@dataclass
class Line:
    text: str
    mood: str | None = None  # None: the profile's default delivery
    speed: float = 1.0
    pause: float = LINE_PAUSE  # silence after the line, seconds


def _read_tag(words: str) -> tuple[str | None, float]:
    mood, speed = None, 1.0
    for word in (w.strip().lower() for w in words.split(",")):
        if not word:
            continue
        if word in PACES:
            speed = PACES[word]
        elif word.startswith("speed"):
            try:
                speed = float(word[5:])
            except ValueError:
                raise ValueError(f"Write the pace as (speed 0.9), not ({word}).") from None
        else:
            name = ALIASES.get(word, word)
            if name not in MOODS:
                raise ValueError(f"Unknown mood ({word}). Use one of: {', '.join(MOODS)}; or slow, fast, speed 0.9.")
            mood = name
    return mood, min(max(speed, SPEED_RANGE[0]), SPEED_RANGE[1])


def parse_script(script: str) -> list[Line]:
    """Split a narration script into lines with their mood, pace and pause."""
    lines: list[Line] = []
    for raw in script.splitlines():
        if not raw.strip():
            if lines:
                lines[-1].pause = max(lines[-1].pause, PARAGRAPH_PAUSE)
            continue
        # "text [pause 1] more text" is two lines; the tag applies to both.
        parts = _PAUSE.split(raw)
        mood, speed = None, 1.0
        for i in range(0, len(parts), 2):
            text = parts[i]
            tag = _TAG.match(text)
            if tag:
                mood, speed = _read_tag(tag.group(1))
                text = text[tag.end() :]
            text = text.strip()
            pause = min(float(parts[i + 1]), MAX_PAUSE) if i + 1 < len(parts) else None
            if text:
                lines.append(Line(text, mood, speed, LINE_PAUSE if pause is None else pause))
            elif pause is not None and lines:
                lines[-1].pause = pause
    if not lines:
        raise ValueError("The script has no text to speak.")
    if len(lines) > MAX_LINES:
        raise ValueError(f"The script has {len(lines)} lines; the limit is {MAX_LINES}. Split it into parts.")
    return lines


# ── mood clips ───────────────────────────────────────────────────────


def _clips_dir(profile_id: str) -> Path:
    return Path(config.get_data_dir()) / "mood_clips" / profile_id


def mood_clips(profile_id: str) -> dict[str, tuple[Path, str]]:
    """The profile's mood clips: mood -> (wav, its transcript)."""
    d = _clips_dir(profile_id)
    try:
        texts = json.loads((d / "clips.json").read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return {m: (d / f"{m}.wav", t) for m, t in texts.items() if m in MOODS and t and (d / f"{m}.wav").is_file()}


def install_mood_clips(profile_id: str, source: Path) -> list[str]:
    """Copy ``<mood>.wav`` files and their transcripts from a folder.

    The folder holds one clip per mood (``fear.wav``, ``happy.wav``, ...) and a
    ``texts.json`` mapping each file's name to what is said in it.
    """
    source = Path(source)
    try:
        texts = json.loads((source / "texts.json").read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"{source} needs a texts.json mapping each clip to its transcript.") from exc
    target = _clips_dir(profile_id)
    target.mkdir(parents=True, exist_ok=True)
    kept = {m: t for m, (_, t) in mood_clips(profile_id).items()}
    for name, text in texts.items():
        mood = ALIASES.get(name.lower(), name.lower())
        wav = next((p for p in (source / f"{name}.wav", source / f"{mood}.wav") if p.is_file()), None)
        if mood not in MOODS or wav is None or not str(text).strip():
            logger.warning("Skipping mood clip %r (unknown mood, missing wav or empty transcript)", name)
            continue
        shutil.copyfile(wav, target / f"{mood}.wav")
        kept[mood] = str(text).strip()
    (target / "clips.json").write_text(json.dumps(kept, ensure_ascii=False, indent=1), "utf-8")
    return sorted(kept)


def remove_mood_clips(profile_id: str) -> None:
    shutil.rmtree(_clips_dir(profile_id), ignore_errors=True)


# ── audio ────────────────────────────────────────────────────────────


def polish(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """Trim silence, level the loudness and fade the edges of one spoken line."""
    from ..backends.f5_fast import _trim_edges

    audio = _trim_edges(np.nan_to_num(np.asarray(audio, dtype=np.float32).squeeze()))
    if audio.size == 0:
        return audio
    # Loudness of the voiced frames only, so a line with gaps is not turned up.
    win = int(0.02 * sample_rate)
    frames = audio[: len(audio) // win * win].reshape(-1, win)
    if len(frames):
        power = np.mean(frames**2, axis=1)
        level = float(np.sqrt(np.mean(power[power > 0.01 * power.max()]))) if power.max() > 0 else 0.0
        if level > 1e-6:
            audio = audio * (TARGET_LOUDNESS / level)
    fade_in, fade_out = int(0.015 * sample_rate), int(0.045 * sample_rate)
    if audio.size > fade_in + fade_out:
        audio[:fade_in] *= np.linspace(0, 1, fade_in, dtype=np.float32)
        audio[-fade_out:] *= np.linspace(1, 0, fade_out, dtype=np.float32)
    return audio


def assemble(
    clips: list[np.ndarray],
    pauses: list[float],
    sample_rate: int,
    target_seconds: float | None = None,
    lead_in: float = 0.4,
    tail: float = 0.6,
) -> tuple[np.ndarray, list[tuple[float, float]]]:
    """Join spoken lines with their pauses. Returns the audio and each line's (start, end).

    ``target_seconds`` stretches or shrinks the pauses (never the speech) to
    land on a length, within 0.6x-1.8x of what the script asked for.
    """
    speech = sum(len(c) for c in clips) / sample_rate
    gaps = pauses[:-1]  # nothing follows the last line but the tail
    scale = 1.0
    if target_seconds and sum(gaps) > 0:
        scale = min(max((target_seconds - speech - lead_in - tail) / sum(gaps), 0.6), 1.8)
    parts, times, t = [np.zeros(int(lead_in * sample_rate), dtype=np.float32)], [], lead_in
    for i, clip in enumerate(clips):
        parts.append(clip.astype(np.float32, copy=False))
        times.append((round(t, 3), round(t + len(clip) / sample_rate, 3)))
        gap = int((gaps[i] * scale if i < len(gaps) else tail) * sample_rate)
        parts.append(np.zeros(gap, dtype=np.float32))
        t += (len(clip) + gap) / sample_rate
    audio = np.concatenate(parts)
    peak = float(np.abs(audio).max()) if audio.size else 0.0
    return (audio * (0.95 / peak) if peak > 0.95 else audio), times


async def narrate(
    db,
    profile,
    script: str,
    *,
    language: str | None = None,
    seed: int | None = None,
    target_seconds: float | None = None,
) -> dict:
    """Speak ``script`` in ``profile``'s voice with IndicF5 and save one WAV."""
    from ..backends import get_tts_backend_for_engine, load_engine_model
    from ..utils.audio import save_audio
    from . import profiles

    lines = parse_script(script)
    engine = "indicf5"
    backend = get_tts_backend_for_engine(engine)
    await load_engine_model(engine)
    base = await profiles.create_voice_prompt_for_profile(profile.id, db, use_cache=True, engine=engine)
    clips = mood_clips(profile.id)
    lang = language or profile.language or "te"

    def prompt_for(mood: str | None) -> dict:
        ref = clips.get(mood or DEFAULT_MOOD)
        return {**base, "ref_audio_path": str(ref[0]), "ref_text": ref[1]} if ref else base

    spoken, sample_rate = [], 24000
    for n, line in enumerate(lines):
        audio, sample_rate = await backend.generate(
            line.text, prompt_for(line.mood), lang, None if seed is None else seed + n, speed=line.speed
        )
        audio = polish(audio, sample_rate)
        if audio.size == 0:
            raise RuntimeError(f"Line {n + 1} came out silent: {line.text[:60]!r}")
        spoken.append(audio)

    audio, times = assemble(spoken, [line.pause for line in lines], sample_rate, target_seconds)
    out_dir = Path(config.get_generations_dir()) / "narrations"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"narration-{uuid.uuid4().hex[:10]}.wav"
    save_audio(audio, str(path), sample_rate)
    asked = {line.mood for line in lines if line.mood}
    return {
        "audio_path": str(path),
        "duration": round(len(audio) / sample_rate, 2),
        "voice": profile.name,
        "lines": [
            {"text": line.text, "mood": line.mood or DEFAULT_MOOD, "start": start, "end": end}
            for line, (start, end) in zip(lines, times, strict=True)
        ],
        "moods_available": sorted(clips),
        "moods_missing": sorted(asked - set(clips)),
    }
