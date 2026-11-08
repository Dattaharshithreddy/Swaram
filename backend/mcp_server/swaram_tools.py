"""Swaram MCP tools: design, clone and speak voices from Claude.

Typical flow when a user asks Claude for "a calm Telugu storyteller voice":

  1. ``swaram_voice_design_guide``   tips + recommended speaker names
  2. ``swaram_preview_voice``        audition 1-3 descriptions (nothing saved)
  3. ``swaram_design_voice``         save the one the user liked; ``lock=True``
                                     turns it into a cloned voice that sounds
                                     identical on every line
  4. ``swaram_speak``                read any text in it; waits and returns the
                                     WAV path and URL

Plus ``swaram_clone_voice`` (from a recording), ``swaram_compare_engines``
(hear IndicF5 vs DhVaani on one voice, with timings), ``swaram_set_quality``
and ``swaram_list_voices``.

Local file paths in results are on the machine running the Swaram server;
``audio_url`` is the same file over HTTP (prefix it with the server URL).
"""

from __future__ import annotations

import asyncio
import base64 as b64
import logging
import tempfile
import time
from pathlib import Path
from typing import Any, Literal

from fastmcp import FastMCP

from ..database import get_db
from .context import request_is_loopback
from .resolve import resolve_profile

logger = logging.getLogger(__name__)

Language = Literal["en", "hi", "te", "ta", "kn", "ml", "mr", "bn", "gu", "or", "pa", "as"]
CloneEngine = Literal["indicf5", "dhvaani", "chatterbox", "qwen", "omnivoice"]
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def _preview_url(path: str) -> str | None:
    p = Path(path)
    if p.parent.name in ("previews", "compare"):
        return f"/indic/design/audio/{p.parent.name}/{p.name}"
    return None


def register_swaram_tools(mcp: FastMCP) -> None:
    @mcp.tool(
        name="swaram_voice_design_guide",
        description=(
            "How to write a voice description for swaram_preview_voice / swaram_design_voice, "
            "with recommended speaker names per language. Call this before designing a voice."
        ),
    )
    async def swaram_voice_design_guide(language: Language | None = None) -> dict[str, Any]:
        from ..backends.indic_parler_backend import RECOMMENDED_SPEAKERS
        from ..services.voice_design import SAMPLE_TEXT

        return {
            "how_to_describe": [
                "Describe: gender, age feel, pitch (low/moderate/high), pace (slow/moderate/fast), "
                "expressiveness (monotone/animated/warm), and recording quality.",
                "Always ask for a clean recording: 'very clear, close-up audio with no background noise'.",
                "Naming a recommended speaker (e.g. 'Lalitha speaks ...') gives a steadier voice.",
                "Write the description in English even for Indian languages; write the spoken text "
                "in the language's own script.",
                "Audition 2-3 variants with swaram_preview_voice (different seeds or wording), then "
                "save the favourite with swaram_design_voice(preview_audio_path=...).",
            ],
            "example": (
                "Lalitha speaks in a warm, slightly low-pitched voice at a calm, unhurried pace, "
                "like a storyteller. Very clear, close-up recording with no background noise."
            ),
            "recommended_speakers": (
                {language: RECOMMENDED_SPEAKERS.get(language, [])} if language else RECOMMENDED_SPEAKERS
            ),
            "default_sample_text": {language: SAMPLE_TEXT[language]} if language else None,
            "engines": {
                "indic_parler": "designs voices from descriptions (English + 11 Indian languages)",
                "indicf5": "clones a voice from a clip; best-known Indian-language quality",
                "dhvaani": "clones a voice from a clip; ~4x smaller, much faster",
            },
        }

    @mcp.tool(
        name="swaram_preview_voice",
        description=(
            "Render a voice from a written description, without saving it. Returns a WAV path/URL "
            "to listen to. Use to audition descriptions before swaram_design_voice."
        ),
    )
    async def swaram_preview_voice(
        description: str,
        language: Language = "te",
        text: str | None = None,
        speaker: str | None = None,
        seed: int | None = None,
    ) -> dict[str, Any]:
        """``text`` defaults to a short read-aloud line in ``language``.
        ``seed`` makes a preview repeatable; try a few seeds for variety."""
        from ..services import voice_design

        result = await voice_design.preview_voice(description, language, text=text, speaker=speaker, seed=seed)
        result["audio_url"] = _preview_url(result["audio_path"])
        return result

    @mcp.tool(
        name="swaram_design_voice",
        description=(
            "Create and save a new voice from a written description (no recording needed). "
            "lock=true (default) renders a sample once and saves it as a cloned voice so every "
            "line sounds identical; pass preview_audio_path to lock a preview you already liked."
        ),
    )
    async def swaram_design_voice(
        name: str,
        description: str,
        language: Language = "te",
        speaker: str | None = None,
        lock: bool = True,
        lock_engine: CloneEngine | None = None,
        sample_text: str | None = None,
        seed: int | None = None,
        preview_audio_path: str | None = None,
    ) -> dict[str, Any]:
        """``lock_engine`` is the cloner used afterwards: IndicF5 by default for
        Indian languages (Chatterbox for English); "dhvaani" is faster."""
        from ..services import voice_design

        if preview_audio_path and not request_is_loopback():
            raise ValueError("`preview_audio_path` is only accepted from loopback callers.")
        db = next(get_db())
        try:
            return await voice_design.design_voice(
                db,
                name=name,
                description=description,
                language=language,
                speaker=speaker,
                lock=lock,
                lock_engine=lock_engine,
                sample_text=sample_text,
                seed=seed,
                preview_audio_path=preview_audio_path,
            )
        finally:
            db.close()

    @mcp.tool(
        name="swaram_clone_voice",
        description=(
            "Clone a voice from a recording (5-12 s of clean speech works best). Pass audio_path "
            "(local server path, loopback only) or audio_base64. transcript is the exact words "
            "spoken; if omitted, Whisper transcribes it (not available for Odia)."
        ),
    )
    async def swaram_clone_voice(
        name: str,
        language: Language = "te",
        audio_path: str | None = None,
        audio_base64: str | None = None,
        transcript: str | None = None,
        engine: CloneEngine | None = None,
    ) -> dict[str, Any]:
        from ..models import VoiceProfileCreate
        from ..services import profiles as profiles_service
        from .tools import _transcribe_file

        if bool(audio_path) == bool(audio_base64):
            raise ValueError("Pass exactly one of `audio_path` or `audio_base64`.")
        tmp: Path | None = None
        if audio_path:
            if not request_is_loopback():
                raise ValueError("`audio_path` is only available to loopback callers; use `audio_base64`.")
            src = Path(audio_path)
            if not src.is_absolute() or not src.is_file():
                raise ValueError(f"Not an absolute path to a file: {audio_path}")
        else:
            raw = b64.b64decode(audio_base64 or "", validate=True)
            if len(raw) > MAX_UPLOAD_BYTES:
                raise ValueError("Audio exceeds 50 MB.")
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(raw)
                tmp = Path(f.name)
            src = tmp

        db = next(get_db())
        try:
            text = (transcript or "").strip()
            if not text:
                if language == "or":
                    raise ValueError("Whisper has no Odia model; pass `transcript`.")
                text = (await _transcribe_file(src, language, None))["text"].strip()
            chosen = engine or ("chatterbox" if language == "en" else "indicf5")
            profile = await profiles_service.create_profile(
                VoiceProfileCreate(name=name, language=language, voice_type="cloned", default_engine=chosen), db
            )
            try:
                await profiles_service.add_profile_sample(profile.id, str(src), text, db)
            except Exception:
                await profiles_service.delete_profile(profile.id, db)
                raise
            return {"profile": profile.model_dump(mode="json"), "engine": chosen, "transcript": text}
        finally:
            db.close()
            if tmp:
                tmp.unlink(missing_ok=True)

    @mcp.tool(
        name="swaram_speak",
        description=(
            "Read text aloud in a saved voice and return the finished WAV (path, URL, duration). "
            "Write Indian-language text in its own script. Waits for the audio unless wait=false."
        ),
    )
    async def swaram_speak(
        text: str,
        voice: str | None = None,
        language: Language | None = None,
        engine: str | None = None,
        quality: Literal["fast", "balanced", "studio"] | None = None,
        seed: int | None = None,
        wait: bool = True,
        timeout_seconds: int = 900,
    ) -> dict[str, Any]:
        """``voice`` is a voice name or id (see swaram_list_voices). ``quality``
        changes the server-wide preset before generating."""
        from .. import models
        from ..routes.generations import generate_speech
        from ..utils.quality import set_quality
        from .context import current_client_id

        if quality:
            set_quality(quality)
        db = next(get_db())
        try:
            vp = resolve_profile(voice, current_client_id.get(), db)
            if vp is None:
                raise ValueError("Voice not found. Use swaram_list_voices, or create one with swaram_design_voice.")
            req = models.GenerationRequest(
                profile_id=vp.id,
                text=text,
                language=language or vp.language or "en",
                engine=engine,
                seed=seed,
                model_size=None,
            )
            gen = await generate_speech(req, db)
            gen_id = gen.id
        finally:
            db.close()

        if not wait:
            return {"generation_id": gen_id, "status": "queued", "poll_tool": "swaram_get_audio"}
        return await _wait_for(gen_id, timeout_seconds)

    @mcp.tool(
        name="swaram_get_audio",
        description="Status of a generation from swaram_speak(wait=false); returns the WAV when done.",
    )
    async def swaram_get_audio(generation_id: str, wait_seconds: int = 0) -> dict[str, Any]:
        return await _wait_for(generation_id, wait_seconds, raise_on_timeout=False)

    @mcp.tool(
        name="swaram_compare_engines",
        description=(
            "Render the same text in one voice with several engines (default IndicF5 and DhVaani) "
            "and report render time and real-time factor for each, so you can pick the engine."
        ),
    )
    async def swaram_compare_engines(
        voice: str,
        text: str,
        language: Language | None = None,
        engines: list[str] | None = None,
    ) -> dict[str, Any]:
        from ..services import voice_design
        from .context import current_client_id

        db = next(get_db())
        try:
            vp = resolve_profile(voice, current_client_id.get(), db)
            if vp is None:
                raise ValueError(f"Voice not found: {voice}")
            lang = language or vp.language or "te"
            results = await voice_design.compare_engines(
                db,
                profile_id=vp.id,
                text=text,
                language=lang,
                engines=engines or (["indicf5", "dhvaani"] if lang != "en" else ["chatterbox", "qwen"]),
            )
            for r in results:
                if r.get("audio_path"):
                    r["audio_url"] = _preview_url(r["audio_path"])
            return {"voice": vp.name, "language": lang, "results": results}
        finally:
            db.close()

    @mcp.tool(
        name="swaram_set_quality",
        description=(
            "Set the speed/quality preset for IndicF5 and DhVaani: fast (fewest steps), "
            "balanced (default), studio (most steps, slowest)."
        ),
    )
    async def swaram_set_quality(quality: Literal["fast", "balanced", "studio"]) -> dict[str, Any]:
        from ..utils.quality import set_quality

        return {"quality": set_quality(quality)}

    @mcp.tool(
        name="swaram_list_voices",
        description="List saved voices (name, language, type, default engine, description).",
    )
    async def swaram_list_voices(language: Language | None = None) -> dict[str, Any]:
        from ..services import profiles as profiles_service

        db = next(get_db())
        try:
            profiles = await profiles_service.list_profiles(db)
            return {
                "voices": [
                    {
                        "id": p.id,
                        "name": p.name,
                        "language": p.language,
                        "type": p.voice_type,
                        "default_engine": p.default_engine,
                        "description": p.description,
                    }
                    for p in profiles
                    if language is None or p.language == language
                ]
            }
        finally:
            db.close()


async def _wait_for(generation_id: str, timeout_seconds: int, raise_on_timeout: bool = True) -> dict[str, Any]:
    from .. import config
    from ..database import Generation

    deadline = time.monotonic() + max(0, timeout_seconds)
    while True:
        db = next(get_db())
        try:
            row = db.query(Generation).filter(Generation.id == generation_id).first()
            if row is None:
                raise ValueError(f"Generation not found: {generation_id}")
            status, error, audio_path, duration = row.status, row.error, row.audio_path, row.duration
        finally:
            db.close()
        if status == "completed":
            resolved = config.resolve_storage_path(audio_path) if audio_path else None
            return {
                "generation_id": generation_id,
                "status": status,
                "audio_path": str(resolved) if resolved else audio_path,
                "audio_url": f"/audio/{generation_id}",
                "duration": duration,
            }
        if status == "failed":
            raise RuntimeError(f"Generation failed: {error}")
        if time.monotonic() >= deadline:
            if raise_on_timeout:
                raise TimeoutError(
                    f"Still {status} after {timeout_seconds}s; call swaram_get_audio('{generation_id}')."
                )
            return {"generation_id": generation_id, "status": status}
        await asyncio.sleep(0.5)
