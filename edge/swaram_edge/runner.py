"""Run the exported graphs with onnxruntime and numpy only.

This is the exact algorithm the phone app runs (mobile/src/edge/), kept in
Python so it can be tested against the original PyTorch model and used to
benchmark. No torch import here.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import onnxruntime as ort

SAMPLE_RATE = 24000
HOP = 256
N_MELS = 100
TARGET_RMS = 0.1
MAX_FRAMES = 4096
CROSS_FADE_SECONDS = 0.15


def sway_schedule(steps: int, coef: float = -1.0) -> np.ndarray:
    t = np.linspace(0.0, 1.0, steps + 1, dtype=np.float64)
    if coef:
        t = t + coef * (np.cos(np.pi / 2 * t) - 1 + t)
    return t.astype(np.float32)


def guided_steps(steps: int, guidance: float) -> int:
    """How many of the first steps get classifier-free guidance; the rest run one branch (half the work)."""
    return max(1, min(steps, int(round(steps * guidance))))


def normalize_ref_text(ref_text: str) -> str:
    """F5-TTS appends ". " so the reference and new text read as two sentences."""
    ref_text = ref_text.strip()
    if ref_text.endswith("。"):
        return ref_text
    if ref_text.endswith("."):
        return ref_text + " "
    return ref_text + ". "


def trim_silence(wav: np.ndarray, threshold_db: float = -42.0, keep_ms: int = 50) -> np.ndarray:
    """Drop leading/trailing silence (20 ms frames below the threshold)."""
    frame = int(0.02 * SAMPLE_RATE)
    if wav.size < frame * 3:
        return wav
    n = wav.size // frame
    energy = np.sqrt(np.mean(wav[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    loud = np.flatnonzero(20 * np.log10(energy) > threshold_db)
    if loud.size == 0:
        return wav
    keep = int(keep_ms / 1000 * SAMPLE_RATE)
    return wav[max(0, loud[0] * frame - keep) : min(wav.size, (loud[-1] + 1) * frame + keep)]


def chunk_text(text: str, max_bytes: int) -> list[str]:
    """Split at sentence/clause punctuation so each chunk fits the model's window."""
    parts = re.split(r"(?<=[;:,.!?।])\s+|(?<=[；：，。！？])", text.strip())
    chunks, cur = [], ""
    for part in parts:
        if not part:
            continue
        candidate = f"{cur} {part}".strip() if cur else part
        if len(candidate.encode("utf-8")) <= max_bytes or not cur:
            cur = candidate
        else:
            chunks.append(cur)
            cur = part
    if cur:
        chunks.append(cur)
    return chunks


@dataclass
class Voice:
    """Everything needed to speak in a cloned voice: computed once, saved on the phone."""

    mel: np.ndarray  # (frames, 100) log-mel of the reference clip
    text: str  # transcript of the reference clip, normalised
    rms: float  # loudness of the original clip

    def save(self, path: str | Path) -> None:
        np.savez_compressed(path, mel=self.mel.astype(np.float16), text=self.text, rms=self.rms)

    @classmethod
    def load(cls, path: str | Path) -> Voice:
        d = np.load(path, allow_pickle=False)
        return cls(mel=d["mel"].astype(np.float32), text=str(d["text"]), rms=float(d["rms"]))


@dataclass
class Timing:
    context: float = 0.0
    steps: float = 0.0
    vocoder: float = 0.0
    frames: int = 0
    audio_seconds: float = 0.0
    step_times: list[float] = field(default_factory=list)

    @property
    def total(self) -> float:
        return self.context + self.steps + self.vocoder

    @property
    def rtf(self) -> float:
        return self.total / self.audio_seconds if self.audio_seconds else float("inf")


class EdgeTTS:
    def __init__(self, model_dir: str | Path, *, int8: bool = True, threads: int | None = None):
        model_dir = Path(model_dir)
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        if threads:
            opts.intra_op_num_threads = threads
        providers = ["CPUExecutionProvider"]

        def session(name: str) -> ort.InferenceSession:
            q = model_dir / name.replace(".onnx", ".int8.onnx")
            path = q if int8 and q.exists() else model_dir / name
            return ort.InferenceSession(str(path), opts, providers=providers)

        self.mel = session("mel.onnx")
        self.context = session("context.onnx")
        self.flow = session("flow.onnx")
        self.vocoder = session("vocoder.onnx")
        vocab = json.loads((model_dir / "vocab.json").read_text(encoding="utf-8"))
        self.vocab = {tok: i for i, tok in enumerate(vocab)}

    # -- cloning ---------------------------------------------------------------

    def make_voice(self, wav: np.ndarray, ref_text: str, max_seconds: float = 15.0) -> Voice:
        """wav: mono float32 at 24 kHz."""
        wav = trim_silence(wav.astype(np.float32))[: int(max_seconds * SAMPLE_RATE)]
        rms = float(np.sqrt(np.mean(wav**2) + 1e-12))
        if rms < TARGET_RMS:
            wav = wav * (TARGET_RMS / rms)
        mel = self.mel.run(None, {"wav": wav[None, :]})[0][0]
        return Voice(mel=mel, text=normalize_ref_text(ref_text), rms=rms)

    # -- speaking --------------------------------------------------------------

    def tokens(self, text: str) -> np.ndarray:
        return np.array([[self.vocab.get(ch, 0) for ch in text]], dtype=np.int64)

    def speak_chunk(
        self,
        voice: Voice,
        text: str,
        *,
        steps: int = 16,
        cfg: float = 2.0,
        sway: float = -1.0,
        guidance: float = 1.0,
        speed: float = 1.0,
        noise: np.ndarray | None = None,
        seed: int | None = None,
        timing: Timing | None = None,
        return_mel: bool = False,
    ):
        ref_frames = voice.mel.shape[0]
        ref_bytes = max(1, len(voice.text.encode("utf-8")))
        gen_bytes = len(text.encode("utf-8"))
        ids = self.tokens(voice.text + text)
        duration = ref_frames + int(ref_frames / ref_bytes * gen_bytes / speed)
        duration = min(max(duration, max(ids.shape[1], ref_frames) + 1), MAX_FRAMES)

        cond = np.zeros((1, duration, N_MELS), dtype=np.float32)
        cond[0, :ref_frames] = voice.mel
        t0 = time.perf_counter()
        ctx = self.context.run(None, {"text": ids, "cond": cond})[0]
        t1 = time.perf_counter()

        if noise is None:
            noise = np.random.default_rng(seed).standard_normal((duration, N_MELS), dtype=np.float32)
        x = noise[None].astype(np.float32)
        ts = sway_schedule(steps, sway)
        n_guided = guided_steps(steps, guidance)
        ctx_cond = np.ascontiguousarray(ctx[:1])
        step_times = []
        for i in range(steps):
            s0 = time.perf_counter()
            if i < n_guided:
                out = self.flow.run(None, {"x": x, "ctx": ctx, "t": ts[i : i + 1]})[0]
                v = out[0:1] + (out[0:1] - out[1:2]) * cfg
            else:
                v = self.flow.run(None, {"x": x, "ctx": ctx_cond, "t": ts[i : i + 1]})[0]
            x = x + (ts[i + 1] - ts[i]) * v
            step_times.append(time.perf_counter() - s0)
        t2 = time.perf_counter()

        x[0, :ref_frames] = voice.mel
        generated = x[0, ref_frames:]
        if return_mel:
            return x[0]
        wav = self.vocoder.run(None, {"mel": generated.T[None].astype(np.float32)})[0][0]
        if voice.rms < TARGET_RMS:
            wav = wav * (voice.rms / TARGET_RMS)
        t3 = time.perf_counter()

        if timing is not None:
            timing.context += t1 - t0
            timing.steps += t2 - t1
            timing.vocoder += t3 - t2
            timing.frames += duration
            timing.audio_seconds += wav.size / SAMPLE_RATE
            timing.step_times.extend(step_times)
        return wav.astype(np.float32)

    def speak(self, voice: Voice, text: str, **kw) -> tuple[np.ndarray, Timing]:
        timing = Timing()
        ref_seconds = voice.mel.shape[0] * HOP / SAMPLE_RATE
        max_bytes = int(len(voice.text.encode("utf-8")) / max(ref_seconds, 1e-3) * (25 - ref_seconds))
        pieces = [self.speak_chunk(voice, c, timing=timing, **kw) for c in chunk_text(text, max(max_bytes, 60))]
        return cross_fade(pieces), timing


def cross_fade(pieces: list[np.ndarray]) -> np.ndarray:
    if not pieces:
        return np.zeros(0, dtype=np.float32)
    out = pieces[0]
    n = int(CROSS_FADE_SECONDS * SAMPLE_RATE)
    for nxt in pieces[1:]:
        k = min(n, out.size, nxt.size)
        if k <= 0:
            out = np.concatenate([out, nxt])
            continue
        fade = np.linspace(0, 1, k, dtype=np.float32)
        mid = out[-k:] * (1 - fade) + nxt[:k] * fade
        out = np.concatenate([out[:-k], mid, nxt[k:]])
    return out
