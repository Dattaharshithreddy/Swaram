"""
Indic Parler-TTS backend: create a voice from a written description.

ai4bharat/indic-parler-tts (Apache-2.0, gated on Hugging Face) speaks
English and 20 Indian languages, including all 11 in Swaram, in a voice
described in plain words, e.g. "Lalitha speaks in a warm, slightly
low-pitched voice at a calm pace. Very clear, close-up recording with no
background noise." No recording is needed.

This is the engine behind "designed" voices for Indian languages
(Qwen VoiceDesign stays the English default). For long scripts, lock a
designed voice into a cloned profile (MCP ``swaram_design_voice`` with
``lock=True``, or ``POST /indic/design/lock``): a short sample is rendered
here once, then IndicF5 or DhVaani clone it, so every line keeps exactly
the same voice. Parler re-samples the voice on each call, so two calls with
the same description sound like siblings, not the same person.

Runtime: ``parler_tts`` pins transformers 4.46.1, which would break other
engines, so the model runs in a separate Python environment as a worker
process (``parler_worker.py``). Set it up once with ``just setup-parler``,
which creates ``<repo>/.venv-parler``. Or point ``SWARAM_PARLER_PYTHON`` at
any interpreter that has ``parler-tts`` installed.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

import numpy as np

from .base import combine_voice_prompts as _combine_voice_prompts, is_model_cached, model_load_progress

logger = logging.getLogger(__name__)

PARLER_HF_REPO = os.environ.get("SWARAM_PARLER_REPO", "ai4bharat/indic-parler-tts")
DEFAULT_DESCRIPTION = (
    "A clear, natural voice with moderate pitch, speaking at a moderate pace. "
    "Very clear, close-up recording with no background noise."
)
MAX_SENTENCE_CHARS = 220  # Parler stays stable up to ~25 s per piece

# Speaker names the model card recommends per language. Naming one in the
# description gives a steadier voice; any other name just means "a voice".
RECOMMENDED_SPEAKERS: dict[str, list[str]] = {
    "as": ["Amit", "Sita"],
    "bn": ["Arjun", "Aditi"],
    "en": ["Thoma", "Mary"],
    "gu": ["Yash", "Neha"],
    "hi": ["Rohit", "Divya"],
    "kn": ["Suresh", "Anu"],
    "ml": ["Anjali", "Harish"],
    "mr": ["Sanjay", "Sunita"],
    "or": ["Manas", "Debjani"],
    "pa": ["Divjot", "Gurpreet"],
    "ta": ["Jaya", "Kavitha"],
    "te": ["Prakash", "Lalitha"],
}

_QUALITY_HINTS = ("clear", "noise", "close", "studio", "recording", "quality")


def build_description(prompt: str, language: str | None = None, speaker: str | None = None) -> str:
    """Turn a free-form voice prompt into the style Parler was trained on.

    Keeps the user's words, adds a named speaker if asked, and adds the
    recording-quality phrase (the model reproduces noise if you don't ask
    for a clean recording).
    """
    text = " ".join((prompt or "").split()).strip() or DEFAULT_DESCRIPTION
    if speaker and speaker.lower() not in text.lower():
        text = f"{speaker}'s voice: {text}"
    if text[-1] not in ".!?":
        text += "."
    if not any(h in text.lower() for h in _QUALITY_HINTS):
        text += " Very clear, close-up recording with no background noise."
    return text


def _default_python() -> str:
    env = os.environ.get("SWARAM_PARLER_PYTHON")
    if env:
        return env
    repo_root = Path(__file__).resolve().parents[2]
    for candidate in (
        repo_root / ".venv-parler" / "bin" / "python",
        repo_root / ".venv-parler" / "Scripts" / "python.exe",
    ):
        if candidate.exists():
            return str(candidate)
    if getattr(sys, "frozen", False):
        raise RuntimeError(
            "Indic Parler-TTS needs its own Python environment. Run `just setup-parler` "
            "or set SWARAM_PARLER_PYTHON to a Python with parler-tts installed."
        )
    return sys.executable


class _Worker:
    """One long-lived worker process; requests are serialised by a lock."""

    def __init__(self, python: str, script: Path | None = None):
        self.python = python
        self.script = script or Path(__file__).with_name("parler_worker.py")
        self.proc: subprocess.Popen | None = None
        self.lock = threading.Lock()
        self.ids = itertools.count(1)
        self.sample_rate: int | None = None

    def _start(self) -> None:
        worker = self.script
        env = dict(os.environ)
        env.pop("PYTHONPATH", None)  # don't leak the server's packages in
        self.proc = subprocess.Popen(
            [self.python, "-u", str(worker)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,  # worker logs go to the server's stderr
            text=True,
            encoding="utf-8",
            env=env,
        )

    def call(self, op: str, **payload) -> dict:
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self._start()
            req_id = next(self.ids)
            assert self.proc is not None
            assert self.proc.stdin is not None
            assert self.proc.stdout is not None
            self.proc.stdin.write(json.dumps({"id": req_id, "op": op, **payload}, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()
            while True:
                line = self.proc.stdout.readline()
                if not line:
                    code = self.proc.poll()
                    self.proc = None
                    raise RuntimeError(
                        f"Indic Parler-TTS worker exited (code {code}). Check the server log; "
                        "usually parler-tts is not installed — run `just setup-parler`."
                    )
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    logger.debug("parler worker: %s", line.rstrip())
                    continue
                if msg.get("id") == req_id:
                    break
            if not msg.get("ok"):
                raise RuntimeError(f"Indic Parler-TTS: {msg.get('error')}")
            if "sample_rate" in msg:
                self.sample_rate = msg["sample_rate"]
            return msg

    def stop(self) -> None:
        with self.lock:
            if self.proc and self.proc.poll() is None:
                try:
                    self.proc.stdin.write(json.dumps({"id": 0, "op": "shutdown"}) + "\n")
                    self.proc.stdin.flush()
                    self.proc.wait(timeout=10)
                except Exception:
                    self.proc.kill()
            self.proc = None


class IndicParlerBackend:
    """Designed voices in English + 11 Indian languages via Indic Parler-TTS."""

    batches_long_text = True

    def __init__(self):
        self.model_size = "default"
        self._worker: _Worker | None = None
        self._loaded = False
        self._load_lock = asyncio.Lock()

    def is_loaded(self) -> bool:
        return self._loaded

    def _get_model_path(self, model_size: str) -> str:
        return PARLER_HF_REPO

    def _is_model_cached(self, model_size: str = "default") -> bool:
        return is_model_cached(PARLER_HF_REPO)

    def _ensure_worker(self) -> _Worker:
        if self._worker is None:
            self._worker = _Worker(_default_python())
        return self._worker

    async def load_model(self, model_size: str = "default") -> None:
        if self._loaded:
            return
        async with self._load_lock:
            if self._loaded:
                return

            def _load():
                with model_load_progress("indic-parler-tts", self._is_model_cached()):
                    info = self._ensure_worker().call("load")
                logger.info("Indic Parler-TTS ready on %s", info.get("device"))

            await asyncio.to_thread(_load)
            self._loaded = True

    def unload_model(self) -> None:
        if self._worker is not None:
            self._worker.stop()
        self._loaded = False

    async def create_voice_prompt(self, audio_path: str, reference_text: str, use_cache: bool = True):
        # Cloned profiles have no description; use a neutral one. Designed
        # profiles get their dict from the profile service directly.
        return {"voice_type": "designed", "design_prompt": DEFAULT_DESCRIPTION}, False

    async def combine_voice_prompts(self, audio_paths, reference_texts):
        return await _combine_voice_prompts(audio_paths, reference_texts)

    async def generate(self, text, voice_prompt, language="en", seed=None, instruct=None):
        from ..utils.audio import load_audio
        from .f5_fast import chunk_text

        description = (voice_prompt or {}).get("design_prompt") or DEFAULT_DESCRIPTION
        if instruct:
            description = f"{description.rstrip('. ')}. {instruct}"
        description = build_description(description, language)

        sentences = chunk_text(text, MAX_SENTENCE_CHARS, measure=len)
        if not sentences:
            return np.zeros(0, dtype=np.float32), 44100
        await self.load_model()

        def _run():
            fd, out = tempfile.mkstemp(suffix=".wav", prefix="parler_")
            os.close(fd)
            try:
                res = self._ensure_worker().call(
                    "generate", texts=sentences, description=description, seed=seed, out=out
                )
                sr = int(res["sample_rate"])
                audio, _ = load_audio(out, sample_rate=sr, mono=True)
                return np.asarray(audio, dtype=np.float32), sr
            finally:
                Path(out).unlink(missing_ok=True)

        return await asyncio.to_thread(_run)
