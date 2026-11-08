"""Swaram additions: Indian-language helpers and subtitle-timed dubbing.

- ``GET  /indic/languages``  languages and which engines speak them
- ``GET  /indic/glossary``   pronunciation glossary
- ``PUT  /indic/glossary``   replace the glossary
- ``POST /indic/prepare``    preview text after glossary + number spelling,
                             with script warnings
- ``POST /dub/srt``          dub a translated .srt with a voice profile and
                             get one time-aligned WAV back
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..database import get_db

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_SRT_BYTES = 2 * 1024 * 1024


class PrepareRequest(BaseModel):
    text: str = Field(..., max_length=50_000)
    language: str = Field(default="te")


class PrepareResponse(BaseModel):
    language: str
    original: str
    prepared: str
    warnings: list[str]


def _supported_languages() -> list[str]:
    from ..backends import SUPPORTED_LANGUAGES

    return SUPPORTED_LANGUAGES


def _require_language(language: str) -> None:
    if language not in _supported_languages():
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported language '{language}'. Use one of: {', '.join(_supported_languages())}",
        )


@router.get("/indic/languages")
async def list_languages():
    """Every supported language with the TTS engines that can speak it."""
    from ..backends import get_tts_model_configs
    from ..utils.indic_text import LANGUAGE_NAMES, SCRIPT_RANGES

    engines: dict[str, set[str]] = {code: set() for code in _supported_languages()}
    for cfg in get_tts_model_configs():
        for code in cfg.languages:
            if code in engines:
                engines[code].add(cfg.engine)
    return [
        {
            "code": code,
            "name": LANGUAGE_NAMES.get(code, code),
            "script": SCRIPT_RANGES[code][2] if code in SCRIPT_RANGES else "Latin",
            "engines": sorted(engines[code]),
        }
        for code in _supported_languages()
    ]


@router.get("/indic/glossary")
async def get_glossary():
    from ..utils.indic_text import load_glossary

    return load_glossary()


@router.put("/indic/glossary")
async def put_glossary(glossary: dict):
    """Replace the glossary. Shape: ``{"te": {"SIP": "ఎస్ఐపీ"}, "*": {...}}``.

    ``"*"`` entries apply to every language.
    """
    from ..utils.indic_text import save_glossary

    try:
        return save_glossary(glossary)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/indic/prepare", response_model=PrepareResponse)
async def prepare(data: PrepareRequest):
    """Show exactly what the voice will be asked to say."""
    from ..utils.indic_text import check_script, prepare_text

    _require_language(data.language)
    prepared = prepare_text(data.text, data.language)
    return PrepareResponse(
        language=data.language,
        original=data.text,
        prepared=prepared,
        warnings=check_script(data.text, data.language),
    )


@router.post("/dub/srt")
async def dub_srt(
    file: UploadFile = File(..., description="Translated subtitles (.srt)"),
    profile: str = Form(..., description="Voice profile name or id"),
    language: str = Form("te"),
    engine: str | None = Form(None, description="Defaults to the profile's engine"),
    model_size: str = Form("default"),
    max_speedup: float = Form(1.25, ge=1.0, le=1.6),
    seed: int | None = Form(None),
    db: Session = Depends(get_db),
):
    """Dub a subtitle file into one WAV aligned to the subtitle timestamps.

    The response is ``audio/wav``. A JSON summary (failed cues, cues that
    had to be sped up or still run long) is in the ``X-Swaram-Report``
    header. ``scripts/swaram_dub.py`` saves it next to the WAV.
    """
    from ..backends import TTS_ENGINES
    from ..services import profiles as profile_service
    from ..services.srt_dub import dub_srt_with_profile, parse_srt
    from ..services.tts import audio_to_wav_bytes

    _require_language(language)

    raw = await file.read()
    if len(raw) > MAX_SRT_BYTES:
        raise HTTPException(status_code=413, detail="Subtitle file is larger than 2 MB")
    try:
        srt_text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Save the .srt as UTF-8 and try again") from exc
    try:
        parse_srt(srt_text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    row = profile_service.get_profile_orm_by_name_or_id(profile, db)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Voice profile '{profile}' not found")

    engine = engine or profile_service.default_engine_for_profile(row)
    if engine not in TTS_ENGINES:
        raise HTTPException(status_code=400, detail=f"Unknown engine '{engine}'")
    try:
        profile_service.validate_profile_engine(row, engine)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    track, report = await dub_srt_with_profile(
        srt_text,
        profile_id=row.id,
        language=language,
        engine=engine,
        model_size=model_size,
        max_speedup=max_speedup,
        seed=seed,
    )
    if report.failed and len(report.failed) == len(report.cues):
        raise HTTPException(
            status_code=500,
            detail=f"Every cue failed. First error: {report.failed[0].error}",
        )

    summary = report.summary()
    summary["cues"] = [c.as_dict() for c in report.cues if c.error or c.speedup > 1.001 or c.overflow_seconds > 0.05]
    header = json.dumps(summary, ensure_ascii=True)
    if len(header) > 6000:  # keep under common header limits
        header = json.dumps(report.summary(), ensure_ascii=True)

    return Response(
        content=audio_to_wav_bytes(track, report.sample_rate),
        media_type="audio/wav",
        headers={
            "X-Swaram-Report": header,
            "Content-Disposition": 'attachment; filename="dub.wav"',
            "Access-Control-Expose-Headers": "X-Swaram-Report",
        },
    )


# ─── Voice design, engine comparison, speed preset ────────────────────────


class QualityBody(BaseModel):
    quality: str = Field(..., pattern="^(fast|balanced|studio)$")


@router.get("/indic/quality")
async def get_quality_preset():
    """Speed/quality preset used by IndicF5 and DhVaani."""
    from ..utils.quality import PRESETS, get_quality

    return {"quality": get_quality(), "presets": list(PRESETS)}


@router.put("/indic/quality")
async def put_quality_preset(body: QualityBody):
    from ..utils.quality import set_quality

    return {"quality": set_quality(body.quality)}


class DesignPreviewBody(BaseModel):
    description: str = Field(..., min_length=3, max_length=2000)
    language: str = Field(default="te")
    text: str | None = Field(None, max_length=2000)
    speaker: str | None = Field(None, max_length=50)
    seed: int | None = Field(None, ge=0)


class DesignBody(DesignPreviewBody):
    name: str = Field(..., min_length=1, max_length=100)
    lock: bool = True
    lock_engine: str | None = Field(None, pattern="^(indicf5|dhvaani|chatterbox|qwen|omnivoice)$")
    preview_id: str | None = Field(None, pattern=r"^preview-[0-9a-f]{10}\.wav$")


class CompareBody(BaseModel):
    profile: str
    text: str = Field(..., min_length=1, max_length=5000)
    language: str | None = None
    engines: list[str] | None = None


def _design_dir(kind: str):
    from pathlib import Path

    from .. import config

    return Path(config.get_generations_dir()) / kind


@router.post("/indic/design/preview")
async def design_preview(body: DesignPreviewBody):
    """Render a described voice to a WAV without saving a profile."""
    from ..services import voice_design

    _require_language(body.language)
    try:
        res = await voice_design.preview_voice(
            body.description, body.language, text=body.text, speaker=body.speaker, seed=body.seed
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    from pathlib import Path

    res["preview_id"] = Path(res.pop("audio_path")).name
    res["audio_url"] = f"/indic/design/audio/previews/{res['preview_id']}"
    return res


@router.post("/indic/design")
async def design_save(body: DesignBody, db: Session = Depends(get_db)):
    """Save a described voice; lock=true turns it into a cloned voice."""
    from ..services import voice_design

    _require_language(body.language)
    preview_path = str(_design_dir("previews") / body.preview_id) if body.preview_id else None
    try:
        res = await voice_design.design_voice(
            db,
            name=body.name,
            description=body.description,
            language=body.language,
            speaker=body.speaker,
            lock=body.lock,
            lock_engine=body.lock_engine,
            sample_text=body.text,
            seed=body.seed,
            preview_audio_path=preview_path,
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    res.pop("sample_audio_path", None)
    return res


@router.get("/indic/design/audio/{kind}/{name}")
async def design_audio(kind: str, name: str):
    """Serve a preview or comparison WAV."""
    import re

    from fastapi.responses import FileResponse

    if kind not in ("previews", "compare") or not re.fullmatch(r"[A-Za-z0-9_\-]+\.wav", name):
        raise HTTPException(status_code=404, detail="Not found")
    path = _design_dir(kind) / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path, media_type="audio/wav")


@router.post("/indic/compare")
async def compare(body: CompareBody, db: Session = Depends(get_db)):
    """Render the same text with several engines for one voice, with timings."""
    from pathlib import Path

    from ..services import voice_design
    from ..services.profiles import get_profile_orm_by_name_or_id

    profile = get_profile_orm_by_name_or_id(body.profile, db)
    if profile is None:
        raise HTTPException(status_code=404, detail=f"Voice not found: {body.profile}")
    language = body.language or profile.language or "te"
    _require_language(language)
    engines = body.engines or (["indicf5", "dhvaani"] if language != "en" else ["chatterbox", "qwen"])
    results = await voice_design.compare_engines(
        db, profile_id=profile.id, text=body.text, language=language, engines=engines
    )
    for r in results:
        if r.get("audio_path"):
            r["audio_url"] = f"/indic/design/audio/compare/{Path(r.pop('audio_path')).name}"
    return {"profile": profile.name, "language": language, "results": results}
