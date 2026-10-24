"""
IndicF5 backend implementation.

Wraps ai4bharat/IndicF5, an F5-TTS model trained on ~1,400 hours of Indian
speech. Zero-shot voice cloning from a short reference clip plus its
transcript, in 11 Indian languages: Assamese, Bengali, Gujarati, Hindi,
Kannada, Malayalam, Marathi, Odia, Punjabi, Tamil and Telugu. 24 kHz output.

Licensing: the model is MIT-licensed, but the Hugging Face repo is gated.
Before the first download, accept the terms on
https://huggingface.co/ai4bharat/IndicF5 and log in once with
``hf auth login`` (or set ``HF_TOKEN``) on the machine that runs the server.

How it differs from the other cloning engines:

  - The checkpoint is loaded through ``transformers.AutoModel`` with
    ``trust_remote_code=True``; the remote model class relies on the
    ``f5_tts`` package from https://github.com/AI4Bharat/IndicF5, which the
    setup script installs ``--no-deps``.
  - It needs the exact transcript of the reference clip. A transcript that
    does not match the audio produces garbled speech, so this backend refuses
    to clone without one instead of guessing.
  - There is no language argument: the model infers the language from the
    script of the input text, so Telugu text must be written in Telugu script.
  - Reference clips work best at 5 to 12 seconds. F5 clips longer references
    to about 15 seconds internally, which then no longer matches the full
    transcript.
"""

import asyncio
import gc
import logging
from pathlib import Path

import numpy as np

from ..utils.cache import cache_voice_prompt, get_cache_key, get_cached_voice_prompt
from .base import (
    combine_voice_prompts as _combine_voice_prompts,
    empty_device_cache,
    get_torch_device,
    is_model_cached,
    manual_seed,
    model_load_progress,
)

logger = logging.getLogger(__name__)

INDICF5_HF_REPO = "ai4bharat/IndicF5"
# Vocoder fetched by f5_tts at load time.
VOCOS_HF_REPO = "charactr/vocos-mel-24khz"

SAMPLE_RATE = 24000

# Languages IndicF5 was trained on (Voicebox two-letter codes).
INDICF5_LANGUAGES = ["as", "bn", "gu", "hi", "kn", "ml", "mr", "or", "pa", "ta", "te"]

# Reference clips longer than this are a common cause of bad clones with F5.
RECOMMENDED_MAX_REF_SECONDS = 15.0

_VOICE_PROMPT_FORMAT_VERSION = 1


class IndicF5Backend:
    """IndicF5 backend for zero-shot voice cloning in Indian languages."""

    def __init__(self):
        self.model = None
        self.model_size = "default"  # IndicF5 ships a single checkpoint
        self._device = None
        self._model_load_lock = asyncio.Lock()

    def _get_device(self) -> str:
        return get_torch_device(allow_mps=True, allow_xpu=False)

    @property
    def device(self) -> str:
        if self._device is None:
            self._device = self._get_device()
        return self._device

    def is_loaded(self) -> bool:
        return self.model is not None

    def _get_model_path(self, model_size: str) -> str:
        return INDICF5_HF_REPO

    def _is_model_cached(self, model_size: str = "default") -> bool:
        return is_model_cached(INDICF5_HF_REPO) and is_model_cached(
            VOCOS_HF_REPO, weight_extensions=(".bin", ".safetensors", ".pt", ".pth")
        )

    async def load_model(self, model_size: str = "default") -> None:
        if self.model is not None:
            return

        # create_voice_prompt() and generate() both call this; two requests
        # arriving together must not load the checkpoint twice.
        async with self._model_load_lock:
            if self.model is not None:
                return
            await asyncio.to_thread(self._load_model_sync)

    def _load_model_sync(self) -> None:
        model_name = "indicf5"
        is_cached = self._is_model_cached()

        with model_load_progress(model_name, is_cached):
            try:
                import f5_tts  # noqa: F401  (needed by the remote model code)
            except ImportError as exc:
                raise RuntimeError(
                    "IndicF5 needs the f5_tts package. Install it with: "
                    "pip install --no-deps git+https://github.com/AI4Bharat/IndicF5.git"
                ) from exc

            from transformers import AutoModel

            try:
                from huggingface_hub.errors import GatedRepoError
            except ImportError:  # older huggingface_hub
                from huggingface_hub.utils import GatedRepoError

            device = self.device
            logger.info("Loading IndicF5 on %s...", device)

            try:
                model = AutoModel.from_pretrained(INDICF5_HF_REPO, trust_remote_code=True)
            except GatedRepoError as exc:
                raise RuntimeError(
                    "IndicF5 is a gated model. Accept its terms at "
                    "https://huggingface.co/ai4bharat/IndicF5, then run "
                    "`hf auth login` (or set HF_TOKEN) and try again."
                ) from exc

            try:
                model = model.to(device)
            except Exception as exc:  # the remote wrapper may manage devices itself
                logger.warning("Could not move IndicF5 to %s (%s); using its default device", device, exc)
            model.eval()
            self.model = model

        logger.info("IndicF5 loaded successfully")

    def unload_model(self) -> None:
        if self.model is not None:
            device = self.device
            del self.model
            self.model = None
            self._device = None
            gc.collect()
            empty_device_cache(device)
            logger.info("IndicF5 unloaded")

    async def create_voice_prompt(
        self,
        audio_path: str,
        reference_text: str,
        use_cache: bool = True,
    ) -> tuple[dict, bool]:
        """Prepare a reusable voice prompt from a reference clip.

        F5 conditions on the raw reference audio, so the "prompt" is a
        24 kHz mono copy of the clip in the cache directory plus its
        transcript. Plain strings keep the cached dict loadable with
        ``torch.load(weights_only=True)``.
        """
        ref_text = (reference_text or "").strip()
        if not ref_text:
            raise ValueError(
                "IndicF5 needs the exact transcript of the reference clip. "
                "Add the reference text to this voice profile (it can be "
                "auto-transcribed with Whisper) and try again."
            )

        cache_key = ("indicf5_" + get_cache_key(audio_path, ref_text)) if use_cache else None

        if cache_key:
            cached = get_cached_voice_prompt(cache_key)
            if (
                isinstance(cached, dict)
                and cached.get("format_version") == _VOICE_PROMPT_FORMAT_VERSION
                and Path(cached.get("ref_audio_path", "")).exists()
            ):
                return cached, True

        def _prepare_sync() -> dict:
            from .. import config
            from ..utils.audio import load_audio, save_audio

            audio, _sr = load_audio(str(audio_path), sample_rate=SAMPLE_RATE, mono=True)
            duration = len(audio) / SAMPLE_RATE
            if duration > RECOMMENDED_MAX_REF_SECONDS:
                logger.warning("IndicF5 reference clip is %.1fs; clips of 5-12s clone best", duration)

            out_dir = Path(config.get_cache_dir()) / "indicf5_refs"
            out_dir.mkdir(parents=True, exist_ok=True)
            name = (cache_key or "indicf5_" + get_cache_key(audio_path, ref_text)) + ".wav"
            out_path = out_dir / name
            save_audio(audio, str(out_path), sample_rate=SAMPLE_RATE)

            return {
                "format_version": _VOICE_PROMPT_FORMAT_VERSION,
                "ref_audio_path": str(out_path),
                "ref_text": ref_text,
            }

        prompt = await asyncio.to_thread(_prepare_sync)

        if cache_key:
            cache_voice_prompt(cache_key, prompt)

        return prompt, False

    async def combine_voice_prompts(self, audio_paths, reference_texts):
        return await _combine_voice_prompts(audio_paths, reference_texts, sample_rate=SAMPLE_RATE)

    async def generate(
        self,
        text: str,
        voice_prompt: dict,
        language: str = "te",
        seed: int | None = None,
        instruct: str | None = None,
    ) -> tuple[np.ndarray, int]:
        """
        Generate speech with IndicF5.

        Args:
            text: Text to synthesize, in the script of the target language.
            voice_prompt: Dict from create_voice_prompt().
            language: Accepted for interface parity; IndicF5 reads the
                language from the script of ``text``.
            seed: Random seed for reproducibility.
            instruct: Not supported (ignored).

        Returns:
            Tuple of (float32 audio array, 24000).
        """
        if not voice_prompt or "ref_audio_path" not in voice_prompt:
            raise ValueError("IndicF5 only clones voices. Pick a cloned voice profile with a reference clip.")
        if voice_prompt.get("format_version") != _VOICE_PROMPT_FORMAT_VERSION:
            raise ValueError(f"Unsupported IndicF5 voice prompt format version: {voice_prompt.get('format_version')}")
        if language not in INDICF5_LANGUAGES:
            logger.info("IndicF5 got language %r; it will follow the script of the text", language)

        await self.load_model()

        def _generate_sync() -> tuple[np.ndarray, int]:
            import torch

            if seed is not None:
                manual_seed(seed, self.device)

            with torch.inference_mode():
                audio = self.model(
                    text,
                    ref_audio_path=voice_prompt["ref_audio_path"],
                    ref_text=voice_prompt["ref_text"],
                )

            if isinstance(audio, torch.Tensor):
                audio = audio.detach().cpu().numpy()
            audio = np.asarray(audio).squeeze()
            if audio.dtype == np.int16:
                audio = audio.astype(np.float32) / 32768.0
            return audio.astype(np.float32), SAMPLE_RATE

        return await asyncio.to_thread(_generate_sync)
