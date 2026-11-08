"""
Faster IndicF5 inference.

The stock ``model(text, ref_audio_path=..., ref_text=...)`` call on the
IndicF5 Hugging Face wrapper does, on every request:

  1. re-reads and silence-splits the reference clip with pydub,
  2. splits the text only on ``. , ; : ! ?`` (Hindi/Marathi ``।`` is ignored,
     so a long Hindi paragraph becomes one over-long chunk, which is when
     F5 starts skipping words),
  3. runs each chunk through 32 flow-matching steps **one after another**,
  4. in full float32.

This module drives the same weights (``model.ema_model`` / ``model.vocoder``)
directly and fixes all four:

  - the reference is prepared once per voice and cached (mel + RMS),
  - text is split on Indic sentence marks too,
  - all chunks of a request go through the model **in one batch** (bounded by
    a frame budget so long scripts don't run out of memory),
  - half precision on CUDA GPUs that support it (opt out with
    ``SWARAM_F5_FP32=1``), falling back to float32 if a batch comes back NaN,
  - a step count chosen by the shared quality preset (``utils/quality.py``).

If the loaded model doesn't expose ``ema_model``/``vocoder`` (a future change
to the remote code), the backend falls back to the stock call.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass

import numpy as np

logger = logging.getLogger(__name__)

SAMPLE_RATE = 24000
HOP_LENGTH = 256
TARGET_RMS = 0.1
CROSS_FADE_SECONDS = 0.12
# F5 was trained on clips up to ~30 s; reference + generated should stay
# around 25 s, as upstream does.
MAX_CLIP_SECONDS = 25.0

# Flow-matching steps per preset. With sway sampling (coef -1) the F5 paper
# reports 16 steps within a hair of 32 on WER / speaker similarity, at half
# the time. "studio" keeps the original 32.
QUALITY_PRESETS: dict[str, int] = {
    "fast": 16,
    "balanced": 24,
    "studio": 32,
}
DEFAULT_QUALITY = "balanced"

CFG_STRENGTH = 2.0
SWAY_SAMPLING_COEF = -1.0

# Upper bound on (batch size x frames) per forward pass. 24k frames ≈ 4 min
# of audio at 93.75 frames/s, comfortably inside an 8 GB GPU in fp16.
DEFAULT_MAX_BATCH_FRAMES = int(os.environ.get("SWARAM_F5_MAX_BATCH_FRAMES", "24000"))

# Sentence ends, including the Devanagari danda and double danda, then
# clause marks. Kept as two passes so we prefer splitting at full stops.
_SENTENCE_RE = re.compile(r"(?<=[.!?।॥|])\s+|(?<=[।॥])")
_CLAUSE_RE = re.compile(r"(?<=[,;:،])\s+")


def quality_steps(quality: str | None = None) -> int:
    """Map a preset name (or a bare integer string) to a step count.

    With no argument, uses the shared preset from ``utils.quality``.
    """
    if quality is None:
        from ..utils.quality import get_quality

        quality = get_quality()
    q = quality.strip().lower()
    if q in QUALITY_PRESETS:
        return QUALITY_PRESETS[q]
    if q.isdigit():
        return max(4, min(64, int(q)))
    logger.warning("Unknown IndicF5 quality %r; using %s", q, DEFAULT_QUALITY)
    return QUALITY_PRESETS[DEFAULT_QUALITY]


def _byte_len(s: str) -> int:
    return len(s.encode("utf-8"))


def chunk_text(text: str, max_bytes: int, measure=_byte_len) -> list[str]:
    """Split text into chunks of at most ``max_bytes`` by ``measure``.

    F5 sizes durations by UTF-8 byte count, so that's the default measure;
    character-level engines (DhVaani) pass ``len``. Splits at sentence ends
    first (``.!?।॥``), then clause marks, then spaces; a single word longer
    than the limit is kept whole.
    """
    _byte_len = measure
    text = " ".join(text.split())
    if not text:
        return []
    max_bytes = max(16, max_bytes)

    def split_with(pieces: list[str], pattern: re.Pattern | None) -> list[str]:
        out: list[str] = []
        for piece in pieces:
            if _byte_len(piece) <= max_bytes:
                out.append(piece)
                continue
            parts = pattern.split(piece) if pattern else piece.split(" ")
            out.extend(p for p in parts if p.strip())
        return out

    units = split_with([text], _SENTENCE_RE)
    units = split_with(units, _CLAUSE_RE)
    units = split_with(units, None)

    chunks: list[str] = []
    current = ""
    for unit in units:
        unit = unit.strip()
        candidate = f"{current} {unit}" if current else unit
        if _byte_len(candidate) <= max_bytes:
            current = candidate
        else:
            if current:
                chunks.append(current)
            current = unit
    if current:
        chunks.append(current)
    return chunks


def ensure_terminal_punct(text: str) -> str:
    """F5 expects the reference transcript to end in a full stop + space."""
    text = text.strip()
    if not text:
        return text
    if text[-1] not in ".!?।॥":
        text += "."
    return text + " "


@dataclass
class PreparedReference:
    """A reference clip ready for F5: normalised audio and its transcript."""

    audio: object  # torch.Tensor (1, samples) at 24 kHz, already RMS-normalised
    rms: float  # original RMS, to restore loudness on output
    text: str  # transcript, ending in ". "

    @property
    def seconds(self) -> float:
        return self.audio.shape[-1] / SAMPLE_RATE

    @property
    def frames(self) -> int:
        return self.audio.shape[-1] // HOP_LENGTH


def prepare_reference(audio: np.ndarray, ref_text: str, trim_silence: bool = True) -> PreparedReference:
    """Normalise a 24 kHz mono reference clip once, the way upstream does per call."""
    import torch

    audio = np.asarray(audio, dtype=np.float32).squeeze()
    if trim_silence:
        audio = _trim_edges(audio)
    # 50 ms of silence after the clip, as upstream, so the prompt doesn't
    # bleed into the first generated syllable.
    audio = np.concatenate([audio, np.zeros(int(0.05 * SAMPLE_RATE), dtype=np.float32)])
    max_ref = int(15.0 * SAMPLE_RATE)
    if len(audio) > max_ref:
        logger.warning("IndicF5 reference is %.1fs; using the first 15s", len(audio) / SAMPLE_RATE)
        audio = audio[:max_ref]
    tensor = torch.from_numpy(audio).unsqueeze(0)
    rms = float(torch.sqrt(torch.mean(tensor**2)).item()) or 1e-6
    if rms < TARGET_RMS:
        tensor = tensor * TARGET_RMS / rms
    return PreparedReference(audio=tensor, rms=rms, text=ensure_terminal_punct(ref_text))


def _trim_edges(audio: np.ndarray, threshold_db: float = -42.0) -> np.ndarray:
    """Cut leading/trailing silence below ``threshold_db`` (10 ms windows)."""
    if audio.size == 0:
        return audio
    win = int(0.01 * SAMPLE_RATE)
    n = len(audio) // win
    if n == 0:
        return audio
    frames = audio[: n * win].reshape(n, win)
    db = 20 * np.log10(np.sqrt(np.mean(frames**2, axis=1)) + 1e-9)
    loud = np.where(db > threshold_db)[0]
    if loud.size == 0:
        return audio
    start = max(0, loud[0] - 1) * win
    end = min(n, loud[-1] + 2) * win
    return audio[start:end]


def _use_half(device: str) -> bool:
    if os.environ.get("SWARAM_F5_FP32", "").strip() in ("1", "true", "yes"):
        return False
    if not str(device).startswith("cuda"):
        return False
    try:
        import torch

        major, _ = torch.cuda.get_device_capability(device)
        return major >= 7
    except Exception:
        return False


def _cross_fade(waves: list[np.ndarray], seconds: float = CROSS_FADE_SECONDS) -> np.ndarray:
    if not waves:
        return np.zeros(0, dtype=np.float32)
    out = waves[0]
    for nxt in waves[1:]:
        n = min(int(seconds * SAMPLE_RATE), len(out), len(nxt))
        if n <= 0:
            out = np.concatenate([out, nxt])
            continue
        fade = np.linspace(0.0, 1.0, n, dtype=np.float32)
        mid = out[-n:] * (1.0 - fade) + nxt[:n] * fade
        out = np.concatenate([out[:-n], mid, nxt[n:]])
    return out.astype(np.float32)


def _batches(durations: list[int], max_frames: int) -> list[list[int]]:
    """Group chunk indices so each batch's padded size stays within budget.

    Chunks are sorted by length first so padding waste stays small.
    """
    order = sorted(range(len(durations)), key=lambda i: durations[i])
    groups: list[list[int]] = []
    current: list[int] = []
    for i in order:
        longest = max([durations[j] for j in current] + [durations[i]])
        if current and longest * (len(current) + 1) > max_frames:
            groups.append(current)
            current = []
        current.append(i)
    if current:
        groups.append(current)
    return groups


def synthesize(
    cfm,
    vocoder,
    ref: PreparedReference,
    text: str,
    *,
    device: str,
    steps: int,
    speed: float = 1.0,
    seed: int | None = None,
    max_batch_frames: int = DEFAULT_MAX_BATCH_FRAMES,
    text_converter=None,
) -> np.ndarray:
    """Generate ``text`` in the reference voice with batched F5 sampling.

    ``cfm`` is the F5 ``CFM`` module (``model.ema_model``), ``vocoder`` the
    Vocos vocoder (``model.vocoder``). Returns float32 audio at 24 kHz.
    """
    import torch

    if text_converter is None:
        from f5_tts.model.utils import convert_char_to_pinyin as text_converter  # type: ignore

    ref_seconds = ref.seconds
    ref_bytes = max(1, _byte_len(ref.text))
    # Same sizing rule as upstream: keep reference + chunk under ~25 s.
    max_bytes = int(ref_bytes / ref_seconds * (MAX_CLIP_SECONDS - ref_seconds))
    chunks = chunk_text(text, max_bytes)
    if not chunks:
        return np.zeros(0, dtype=np.float32)

    ref_frames = ref.frames
    durations = [ref_frames + int(ref_frames / ref_bytes * _byte_len(c) / speed) for c in chunks]

    audio = ref.audio.to(device)
    half = _use_half(device)

    with torch.inference_mode():
        # Mel of the reference once, reused for every chunk in every batch.
        ref_mel = cfm.mel_spec(audio).permute(0, 2, 1)  # (1, frames, n_mels)

    waves: list[np.ndarray | None] = [None] * len(chunks)
    for group in _batches(durations, max_batch_frames):
        texts = text_converter([ref.text + chunks[i] for i in group])
        dur = torch.tensor([durations[i] for i in group], device=device, dtype=torch.long)
        cond = ref_mel.expand(len(group), -1, -1).contiguous()
        lens = torch.full((len(group),), ref_mel.shape[1], device=device, dtype=torch.long)

        def run(use_half: bool, cond=cond, texts=texts, dur=dur, lens=lens):
            with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.float16, enabled=use_half):
                out, _ = cfm.sample(
                    cond=cond,
                    text=texts,
                    duration=dur,
                    lens=lens,
                    steps=steps,
                    cfg_strength=CFG_STRENGTH,
                    sway_sampling_coef=SWAY_SAMPLING_COEF,
                    seed=seed,
                )
            return out.float()

        generated = run(half)
        if half and not torch.isfinite(generated).all():
            logger.warning("IndicF5 half-precision batch produced NaN/Inf; redoing it in float32")
            generated = run(False)

        with torch.inference_mode():
            for row, i in enumerate(group):
                mel = generated[row : row + 1, ref_frames : durations[i], :].permute(0, 2, 1)
                wave = vocoder.decode(mel).squeeze().float().cpu().numpy()
                if ref.rms < TARGET_RMS:
                    wave = wave * ref.rms / TARGET_RMS
                waves[i] = np.asarray(wave, dtype=np.float32)

    return _cross_fade([w for w in waves if w is not None])
