"""Create voices from a written description, and compare engines.

- ``preview_voice``   render a description to a WAV without saving anything,
                      so a caller (Claude via MCP, or the app) can audition
                      several descriptions quickly.
- ``design_voice``    save a description as a voice. With ``lock=True`` a
                      sample is rendered once and saved as a *cloned* profile
                      (exact transcript known), so IndicF5/DhVaani reproduce
                      the same voice on every line — Parler alone re-samples
                      the voice on each call.
- ``compare_engines`` render the same text with several engines for one
                      voice and report time and real-time factor for each.

Inference here calls the engine directly instead of going through the
generation queue, behind one lock so two design calls never share the GPU.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path

from sqlalchemy.orm import Session

from .. import config
from ..models import VoiceProfileCreate

logger = logging.getLogger(__name__)

_infer_lock = asyncio.Lock()

# Read-aloud lines used when locking a designed voice (5-10 s each). Written
# to read the same for any speaker gender.
SAMPLE_TEXT: dict[str, str] = {
    "en": "Hello, let me tell you a little about today. The weather is lovely, so it is a good day to learn something new.",
    "te": "నమస్కారం, నా పేరు మీకు చెప్తాను. ఈ రోజు వాతావరణం చాలా బాగుంది, అందుకే నేను బయట నడవడానికి వెళ్తున్నాను.",
    "hi": "नमस्ते, आज मौसम बहुत अच्छा है। चलिए, आज हम साथ में कुछ नया सीखते हैं।",
    "ta": "வணக்கம், இன்று வானிலை மிகவும் நன்றாக இருக்கிறது, அதனால் நான் கொஞ்சம் நடக்கப் போகிறேன்.",
    "kn": "ನಮಸ್ಕಾರ, ಇವತ್ತು ಹವಾಮಾನ ತುಂಬಾ ಚೆನ್ನಾಗಿದೆ, ಅದಕ್ಕೆ ನಾನು ಸ್ವಲ್ಪ ನಡೆಯಲು ಹೋಗುತ್ತಿದ್ದೇನೆ.",
    "ml": "നമസ്കാരം, ഇന്ന് കാലാവസ്ഥ വളരെ നല്ലതാണ്, അതുകൊണ്ട് ഞാൻ കുറച്ചു നടക്കാൻ പോകുന്നു.",
    "mr": "नमस्कार, आज हवामान खूप छान आहे, म्हणून मी थोडं फिरायला जात आहे.",
    "bn": "নমস্কার, আজ আবহাওয়া খুব সুন্দর, তাই আমি একটু হাঁটতে যাচ্ছি।",
    "gu": "નમસ્તે, આજે હવામાન ખૂબ સરસ છે, એટલે હું થોડું ચાલવા જાઉં છું.",
    "or": "ନମସ୍କାର, ଆଜି ପାଣିପାଗ ବହୁତ ଭଲ ଅଛି, ତେଣୁ ମୁଁ ଟିକେ ବୁଲିବାକୁ ଯାଉଛି।",
    "pa": "ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਅੱਜ ਮੌਸਮ ਬਹੁਤ ਵਧੀਆ ਹੈ। ਆਓ, ਅੱਜ ਮਿਲ ਕੇ ਕੁਝ ਨਵਾਂ ਸਿੱਖੀਏ।",
    "as": "নমস্কাৰ, আজি বতৰ বৰ ভাল, সেয়েহে মই অলপ খোজ কাঢ়িবলৈ গৈছোঁ।",
}

# Engine that clones a locked voice, per language.
LOCK_ENGINE_DEFAULT = {"en": "chatterbox"}
LOCK_ENGINE_INDIC = "indicf5"


def design_engine_for(language: str) -> str:
    from .profiles import default_design_engine

    return default_design_engine(language)


def _out_dir(kind: str) -> Path:
    d = Path(config.get_generations_dir()) / kind
    d.mkdir(parents=True, exist_ok=True)
    return d


async def _render(engine: str, text: str, voice_prompt: dict, language: str, seed: int | None):
    from ..backends import get_tts_backend_for_engine, get_tts_model_configs, load_engine_model
    from ..utils.chunked_tts import generate_chunked

    backend = get_tts_backend_for_engine(engine)
    sizes = [c.model_size for c in get_tts_model_configs() if c.engine == engine]
    async with _infer_lock:
        await load_engine_model(engine, sizes[0] if sizes else "default")
        started = time.perf_counter()
        audio, sr = await generate_chunked(backend, text, voice_prompt, language=language, seed=seed)
        elapsed = time.perf_counter() - started
    return audio, sr, elapsed


async def preview_voice(
    description: str,
    language: str = "en",
    text: str | None = None,
    speaker: str | None = None,
    seed: int | None = None,
    engine: str | None = None,
) -> dict:
    """Render a described voice to a WAV file; nothing is saved to the library."""
    from ..backends.indic_parler_backend import build_description
    from ..utils.audio import save_audio

    engine = engine or design_engine_for(language)
    desc = build_description(description, language, speaker)
    text = text or SAMPLE_TEXT.get(language, SAMPLE_TEXT["en"])
    audio, sr, elapsed = await _render(engine, text, {"voice_type": "designed", "design_prompt": desc}, language, seed)
    path = _out_dir("previews") / f"preview-{uuid.uuid4().hex[:10]}.wav"
    await asyncio.to_thread(save_audio, audio, str(path), sr)
    return {
        "audio_path": str(path),
        "description": desc,
        "engine": engine,
        "language": language,
        "text": text,
        "seed": seed,
        "seconds": round(len(audio) / sr, 2),
        "render_seconds": round(elapsed, 2),
    }


async def design_voice(
    db: Session,
    *,
    name: str,
    description: str,
    language: str = "en",
    speaker: str | None = None,
    lock: bool = True,
    lock_engine: str | None = None,
    sample_text: str | None = None,
    seed: int | None = None,
    preview_audio_path: str | None = None,
) -> dict:
    """Save a described voice.

    ``lock=True`` (default): render ``sample_text`` once in the described
    voice (or reuse ``preview_audio_path`` from ``preview_voice``) and save
    it as a cloned profile whose default engine is ``lock_engine``. Every
    later line then has exactly this voice.

    ``lock=False``: save a designed profile; each generation re-reads the
    description, so the voice varies slightly between calls.
    """
    from ..backends.indic_parler_backend import build_description
    from . import profiles as profiles_service

    desc = build_description(description, language, speaker)

    if not lock:
        profile = await profiles_service.create_profile(
            VoiceProfileCreate(
                name=name,
                description=desc[:500],
                language=language,
                voice_type="designed",
                design_prompt=desc,
                default_engine=design_engine_for(language),
            ),
            db,
        )
        return {"profile": profile.model_dump(mode="json"), "locked": False, "description": desc}

    text = sample_text or SAMPLE_TEXT.get(language, SAMPLE_TEXT["en"])
    if preview_audio_path:
        audio_path = preview_audio_path
        if not Path(audio_path).is_file():
            raise ValueError(f"Preview audio not found: {audio_path}")
    else:
        preview = await preview_voice(desc, language, text=text, seed=seed)
        audio_path = preview["audio_path"]

    engine = lock_engine or LOCK_ENGINE_DEFAULT.get(language, LOCK_ENGINE_INDIC)
    profile = await profiles_service.create_profile(
        VoiceProfileCreate(
            name=name,
            description=desc[:500],
            language=language,
            voice_type="cloned",
            default_engine=engine,
        ),
        db,
    )
    try:
        await profiles_service.add_profile_sample(profile.id, audio_path, text, db)
    except Exception:
        await profiles_service.delete_profile(profile.id, db)
        raise
    return {
        "profile": profile.model_dump(mode="json"),
        "locked": True,
        "engine": engine,
        "description": desc,
        "sample_audio_path": audio_path,
        "sample_text": text,
    }


async def compare_engines(
    db: Session,
    *,
    profile_id: str,
    text: str,
    language: str,
    engines: list[str],
    seed: int | None = 7,
) -> list[dict]:
    """Render ``text`` with each engine for one voice; report speed per engine."""
    from ..utils.audio import save_audio
    from . import profiles as profiles_service

    results = []
    for engine in engines:
        entry: dict = {"engine": engine}
        try:
            voice_prompt = await profiles_service.create_voice_prompt_for_profile(
                profile_id, db, use_cache=True, engine=engine
            )
            audio, sr, elapsed = await _render(engine, text, voice_prompt, language, seed)
            seconds = len(audio) / sr if sr else 0.0
            path = _out_dir("compare") / f"{engine}-{uuid.uuid4().hex[:8]}.wav"
            await asyncio.to_thread(save_audio, audio, str(path), sr)
            entry.update(
                audio_path=str(path),
                audio_seconds=round(seconds, 2),
                render_seconds=round(elapsed, 2),
                realtime_factor=round(elapsed / seconds, 3) if seconds else None,
            )
        except Exception as exc:  # report and keep comparing
            entry["error"] = str(exc)
        results.append(entry)
    return results
