"""
DhVaani backend: fast zero-shot voice cloning in 27 Indian languages.

DhVaani-0.5 (ARTPARK, IISc Bengaluru) is a ~0.1B-parameter ZipVoice
flow-matching model trained on IndicTTS, Rasa and IISc SYSPIN. Weights are
Apache-2.0 (free for commercial use; the Hugging Face repo is gated, so
accept the terms on https://huggingface.co/ARTPARK-IISc/DhVaani-0.5 and log
in with ``hf auth login`` or set ``HF_TOKEN``). Respect the training
corpora's terms as well.

Why it's here: it's about a quarter the size of IndicF5 and samples in 16
steps without classifier-free guidance doubling, so it is several times
faster per sentence, and it covers every Swaram language plus 16 more.
Quality relative to IndicF5 has not been published; use the
``swaram_compare_engines`` MCP tool (or ``POST /indic/compare``) to hear
both on your own voice and pick per language.

Integration: the repo ships the standard ZipVoice files (``model.json``,
``tokens.txt`` with a 1,058-character vocabulary, and a checkpoint), so it
loads with the ``zipvoice`` package Swaram already installs for LuxTTS,
using the character-level ``SimpleTokenizer``. Like IndicF5 it needs the
exact transcript of the reference clip; 3-10 s clean clips work best.
"""

from __future__ import annotations

import asyncio
import gc
import json
import logging
import os
import unicodedata
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

DHVAANI_HF_REPO = os.environ.get("SWARAM_DHVAANI_REPO", "ARTPARK-IISc/DhVaani-0.5")
VOCOS_HF_REPO = "charactr/vocos-mel-24khz"
SAMPLE_RATE = 24000

# All eleven Swaram Indian languages are in DhVaani's 27.
DHVAANI_LANGUAGES = ["as", "bn", "gu", "hi", "kn", "ml", "mr", "or", "pa", "ta", "te"]

# ZipVoice (non-distilled) defaults are 16 steps, guidance 1.0. "fast" is the
# distilled-model step count; quality loss at 8 steps on the base model is
# audible on some voices, which is why it isn't the default.
QUALITY_STEPS = {"fast": 8, "balanced": 16, "studio": 32}
GUIDANCE_SCALE = 1.0
T_SHIFT = 0.5
TARGET_RMS = 0.1
FEAT_SCALE = 0.1
# Seconds of audio per forward batch (prompt included per item).
MAX_BATCH_SECONDS = float(os.environ.get("SWARAM_DHVAANI_MAX_BATCH_SECONDS", "200"))

_VOICE_PROMPT_FORMAT_VERSION = 1


def _find_checkpoint(model_dir: Path) -> Path:
    """The weights file: prefer names like model.*, then any .safetensors/.pt."""
    candidates = sorted(
        [p for p in model_dir.rglob("*") if p.suffix in (".safetensors", ".pt") and p.is_file()],
        key=lambda p: (not p.stem.startswith("model"), p.suffix != ".safetensors", len(str(p))),
    )
    if not candidates:
        raise RuntimeError(f"No .safetensors or .pt checkpoint found in {model_dir}")
    return candidates[0]


class DhVaaniBackend:
    """DhVaani-0.5 (ZipVoice) backend for fast Indian-language cloning."""

    batches_long_text = True

    def __init__(self):
        self.model = None
        self.vocoder = None
        self.tokenizer = None
        self.feature_extractor = None
        self.model_size = "default"
        self._device = None
        self._model_load_lock = asyncio.Lock()
        self._prompt_cache: dict = {}

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
        return DHVAANI_HF_REPO

    def _is_model_cached(self, model_size: str = "default") -> bool:
        return is_model_cached(DHVAANI_HF_REPO, weight_extensions=(".safetensors", ".pt")) and is_model_cached(
            VOCOS_HF_REPO, weight_extensions=(".bin", ".safetensors", ".pt", ".pth")
        )

    async def load_model(self, model_size: str = "default") -> None:
        if self.model is not None:
            return
        async with self._model_load_lock:
            if self.model is not None:
                return
            await asyncio.to_thread(self._load_model_sync)

    def _load_model_sync(self) -> None:
        with model_load_progress("dhvaani", self._is_model_cached()):
            try:
                from zipvoice.models.zipvoice import ZipVoice
                from zipvoice.tokenizer.tokenizer import SimpleTokenizer
                from zipvoice.utils.feature import VocosFbank
            except ImportError as exc:
                raise RuntimeError(
                    "DhVaani needs the zipvoice package (installed with LuxTTS). "
                    "Run `just setup`, or: pip install git+https://github.com/k2-fsa/ZipVoice.git"
                ) from exc
            import torch
            from huggingface_hub import snapshot_download
            from vocos import Vocos

            try:
                from huggingface_hub.errors import GatedRepoError
            except ImportError:  # older huggingface_hub
                from huggingface_hub.utils import GatedRepoError

            try:
                model_dir = Path(snapshot_download(DHVAANI_HF_REPO))
            except GatedRepoError as exc:
                raise RuntimeError(
                    "DhVaani is a gated model. Accept its terms at "
                    f"https://huggingface.co/{DHVAANI_HF_REPO}, then run "
                    "`hf auth login` (or set HF_TOKEN) and try again."
                ) from exc

            config_path = next(model_dir.rglob("model.json"), None)
            token_path = next(model_dir.rglob("tokens.txt"), None)
            if config_path is None or token_path is None:
                raise RuntimeError(f"{DHVAANI_HF_REPO} is missing model.json or tokens.txt")
            ckpt = _find_checkpoint(model_dir)

            tokenizer = SimpleTokenizer(token_file=str(token_path))
            config = json.loads(config_path.read_text(encoding="utf-8"))
            model_kwargs = config.get("model", config)
            model = ZipVoice(**model_kwargs, vocab_size=tokenizer.vocab_size, pad_id=tokenizer.pad_id)

            if ckpt.suffix == ".safetensors":
                import safetensors.torch

                safetensors.torch.load_model(model, str(ckpt))
            else:
                from zipvoice.utils.checkpoint import load_checkpoint

                load_checkpoint(filename=str(ckpt), model=model, strict=True)

            device = self.device
            logger.info("Loading DhVaani (%s) on %s", ckpt.name, device)
            model = model.to(device).eval()
            vocoder = Vocos.from_pretrained(VOCOS_HF_REPO).to(device).eval()

            if device == "cpu":
                torch.set_num_threads(min(os.cpu_count() or 4, 8))

            self.tokenizer = tokenizer
            self.feature_extractor = VocosFbank()
            self.vocoder = vocoder
            self.model = model
        logger.info("DhVaani loaded")

    def unload_model(self) -> None:
        if self.model is not None:
            device = self.device
            self.model = None
            self.vocoder = None
            self._prompt_cache.clear()
            self._device = None
            gc.collect()
            empty_device_cache(device)
            logger.info("DhVaani unloaded")

    async def create_voice_prompt(self, audio_path: str, reference_text: str, use_cache: bool = True):
        ref_text = (reference_text or "").strip()
        if not ref_text:
            raise ValueError(
                "DhVaani needs the exact transcript of the reference clip. Add the "
                "reference text to this voice profile (Whisper can fill it in) and try again."
            )
        cache_key = ("dhvaani_" + get_cache_key(audio_path, ref_text)) if use_cache else None
        if cache_key:
            cached = get_cached_voice_prompt(cache_key)
            if (
                isinstance(cached, dict)
                and cached.get("format_version") == _VOICE_PROMPT_FORMAT_VERSION
                and Path(cached.get("ref_audio_path", "")).exists()
            ):
                return cached, True

        def _prepare() -> dict:
            from .. import config
            from ..utils.audio import load_audio, save_audio

            audio, _ = load_audio(str(audio_path), sample_rate=SAMPLE_RATE, mono=True)
            if len(audio) / SAMPLE_RATE > 12:
                logger.warning("DhVaani reference is %.1fs; 3-10 s clips clone best", len(audio) / SAMPLE_RATE)
            out_dir = Path(config.get_cache_dir()) / "dhvaani_refs"
            out_dir.mkdir(parents=True, exist_ok=True)
            out = out_dir / ((cache_key or "dhvaani_" + get_cache_key(audio_path, ref_text)) + ".wav")
            save_audio(audio, str(out), sample_rate=SAMPLE_RATE)
            return {"format_version": _VOICE_PROMPT_FORMAT_VERSION, "ref_audio_path": str(out), "ref_text": ref_text}

        prompt = await asyncio.to_thread(_prepare)
        if cache_key:
            cache_voice_prompt(cache_key, prompt)
        return prompt, False

    async def combine_voice_prompts(self, audio_paths, reference_texts):
        return await _combine_voice_prompts(audio_paths, reference_texts, sample_rate=SAMPLE_RATE)

    def _prompt(self, voice_prompt: dict):
        """(features, token ids, rms, seconds) for a reference, computed once."""
        from zipvoice.utils.infer import add_punctuation, load_prompt_wav, remove_silence, rms_norm

        key = (voice_prompt["ref_audio_path"], voice_prompt["ref_text"])
        hit = self._prompt_cache.get(key)
        if hit is not None:
            return hit
        wav = load_prompt_wav(voice_prompt["ref_audio_path"], sampling_rate=SAMPLE_RATE)
        wav = remove_silence(wav, SAMPLE_RATE, only_edge=False, trail_sil=200)
        wav, rms = rms_norm(wav, TARGET_RMS)
        feats = self.feature_extractor.extract(wav, sampling_rate=SAMPLE_RATE).to(self.device)
        feats = feats.unsqueeze(0) * FEAT_SCALE
        text = _normalize(add_punctuation(voice_prompt["ref_text"]))
        tokens = self.tokenizer.texts_to_token_ids([text])[0]
        entry = (feats, tokens, float(rms), wav.shape[-1] / SAMPLE_RATE, len(text))
        if len(self._prompt_cache) >= 32:
            self._prompt_cache.pop(next(iter(self._prompt_cache)))
        self._prompt_cache[key] = entry
        return entry

    async def generate(self, text, voice_prompt, language="te", seed=None, instruct=None):
        if not voice_prompt or "ref_audio_path" not in voice_prompt:
            raise ValueError("DhVaani only clones voices. Pick a cloned voice profile with a reference clip.")
        await self.load_model()

        def _run():
            import torch
            from zipvoice.utils.infer import add_punctuation, batchify_tokens, cross_fade_concat, remove_silence

            from ..utils.quality import get_quality
            from .f5_fast import chunk_text

            if seed is not None:
                manual_seed(seed, self.device)

            feats, prompt_tokens, rms, prompt_seconds, prompt_chars = self._prompt(voice_prompt)
            # Seconds per character in this speaker's reference.
            char_seconds = prompt_seconds / max(1, prompt_chars)
            max_chars = max(20, int((25 - prompt_seconds) / char_seconds))
            chunks = [_normalize(add_punctuation(c)) for c in chunk_text(text, max_chars, measure=len)]
            if not chunks:
                return np.zeros(0, dtype=np.float32), SAMPLE_RATE
            chunk_tokens = self.tokenizer.texts_to_token_ids(chunks)
            batches, index = batchify_tokens(chunk_tokens, MAX_BATCH_SECONDS, prompt_seconds, char_seconds)

            steps = QUALITY_STEPS.get(get_quality(), QUALITY_STEPS["balanced"])
            wavs = []
            with torch.inference_mode():
                for batch in batches:
                    n = len(batch)
                    pred, pred_lens, _, _ = self.model.sample(
                        tokens=batch,
                        prompt_tokens=[prompt_tokens] * n,
                        prompt_features=feats.repeat(n, 1, 1),
                        prompt_features_lens=torch.full((n,), feats.size(1), device=self.device),
                        speed=1.0,
                        t_shift=T_SHIFT,
                        duration="predict",
                        num_step=steps,
                        guidance_scale=GUIDANCE_SCALE,
                    )
                    pred = pred.permute(0, 2, 1) / FEAT_SCALE
                    for i in range(n):
                        wav = self.vocoder.decode(pred[i][None, :, : pred_lens[i]]).squeeze(1).clamp(-1, 1)
                        if rms < TARGET_RMS:
                            wav = wav * rms / TARGET_RMS
                        wavs.append(wav)
            ordered = [w for _, w in sorted(zip(index, wavs, strict=True), key=lambda x: x[0])]
            final = cross_fade_concat(ordered, fade_duration=0.1, sample_rate=SAMPLE_RATE)
            final = remove_silence(final, SAMPLE_RATE, only_edge=True, trail_sil=0)
            return final.squeeze().float().cpu().numpy().astype(np.float32), SAMPLE_RATE

        return await asyncio.to_thread(_run)


def _normalize(text: str) -> str:
    """NFC so composed Indic characters match the character vocabulary."""
    return unicodedata.normalize("NFC", text)
