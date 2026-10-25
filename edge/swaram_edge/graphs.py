"""Phone-friendly graphs for IndicF5.

F5-TTS runs its whole transformer, including the text encoder and the
reference-audio projection, on every one of 32 sampling steps, and runs it
twice per step for classifier-free guidance. On a phone that is wasted work.
The model is split into four ONNX graphs instead:

``mel``      wav (24 kHz) -> log-mel frames. Runs once when a voice is cloned.
``context``  text ids + reference mel -> per-frame context for the
             conditional and the unconditional (guidance) branch. Runs once
             per sentence; it holds the text encoder and the part of the
             input projection that does not depend on the noisy audio.
``step``     noisy mel + context + time -> guided velocity. Runs N times.
             Both guidance branches go through the transformer as one
             batch of 2, and the guidance mix happens inside the graph.
``vocoder``  log-mel -> wav (Vocos backbone + an iSTFT written as matrix
             products and a transposed convolution, so it exports cleanly).

The split is exact: ``tests/test_parity.py`` checks it against the original
PyTorch model.
"""

from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

from .f5 import HOP_LENGTH, N_FFT, N_MELS, SAMPLE_RATE, WIN_LENGTH


# ---------------------------------------------------------------------------
# STFT helpers built from fixed matrices (ONNX-friendly, no complex numbers)
# ---------------------------------------------------------------------------


def _dft_bases(n_fft: int) -> tuple[torch.Tensor, torch.Tensor]:
    n = torch.arange(n_fft, dtype=torch.float64)
    k = torch.arange(n_fft // 2 + 1, dtype=torch.float64)
    ang = 2 * math.pi * torch.outer(k, n) / n_fft
    return torch.cos(ang).float(), -torch.sin(ang).float()  # real, imag


class MelEncoder(nn.Module):
    """torchaudio MelSpectrogram(power=1, center=True, htk, no norm) + log."""

    def __init__(self):
        super().__init__()
        import torchaudio

        window = torch.hann_window(WIN_LENGTH)
        real, imag = _dft_bases(N_FFT)
        # conv1d kernels: (freq, 1, n_fft) with the window folded in.
        self.register_buffer("k_real", (real * window).unsqueeze(1))
        self.register_buffer("k_imag", (imag * window).unsqueeze(1))
        fb = torchaudio.functional.melscale_fbanks(
            n_freqs=N_FFT // 2 + 1,
            f_min=0.0,
            f_max=SAMPLE_RATE / 2,
            n_mels=N_MELS,
            sample_rate=SAMPLE_RATE,
            norm=None,
            mel_scale="htk",
        )
        self.register_buffer("fb", fb)  # (freq, mels)

    def forward(self, wav: torch.Tensor) -> torch.Tensor:  # (1, samples) -> (1, frames, mels)
        x = F.pad(wav.unsqueeze(1), (N_FFT // 2, N_FFT // 2), mode="reflect")
        re = F.conv1d(x, self.k_real, stride=HOP_LENGTH)
        im = F.conv1d(x, self.k_imag, stride=HOP_LENGTH)
        mag = torch.sqrt(re * re + im * im)  # (1, freq, frames)
        mel = torch.matmul(mag.transpose(1, 2), self.fb)  # (1, frames, mels)
        return torch.log(torch.clamp(mel, min=1e-5))


class VocosDecoder(nn.Module):
    """Vocos (charactr/vocos-mel-24khz) decode with an export-friendly iSTFT."""

    def __init__(self, vocos):
        super().__init__()
        self.backbone = vocos.backbone
        self.out = vocos.head.out
        head_istft = vocos.head.istft
        assert head_istft.padding == "same", "Vocos head is expected to use 'same' padding"
        n_fft, hop, win = head_istft.n_fft, head_istft.hop_length, head_istft.win_length
        self.n_fft, self.hop, self.win = n_fft, hop, win
        window = head_istft.window.float()
        # irfft of one frame as two real matmuls (Hermitian weights), then window.
        n = torch.arange(n_fft, dtype=torch.float64)
        k = torch.arange(n_fft // 2 + 1, dtype=torch.float64)
        ang = 2 * math.pi * torch.outer(k, n) / n_fft
        w = torch.full((n_fft // 2 + 1, 1), 2.0, dtype=torch.float64)
        w[0] = 1.0
        w[-1] = 1.0
        self.register_buffer("ib_real", (w * torch.cos(ang) / n_fft).float() * window)
        self.register_buffer("ib_imag", (-w * torch.sin(ang) / n_fft).float() * window)
        # Overlap-add as a transposed conv with an identity kernel.
        self.register_buffer("ola", torch.eye(win).unsqueeze(1))  # (win, 1, win)
        self.register_buffer("win_sq", (window * window).view(1, win, 1))
        self.pad = (win - hop) // 2

    def forward(self, mel: torch.Tensor) -> torch.Tensor:  # (1, mels, frames) -> (1, samples)
        x = self.backbone(mel)
        x = self.out(x).transpose(1, 2)  # (1, 2*freq, frames)
        mag, phase = x.chunk(2, dim=1)
        mag = torch.clamp(torch.exp(mag), max=1e2)
        re = mag * torch.cos(phase)
        im = mag * torch.sin(phase)
        # frames: (1, frames, n_fft)
        frames = torch.matmul(re.transpose(1, 2), self.ib_real) + torch.matmul(im.transpose(1, 2), self.ib_imag)
        y = F.conv_transpose1d(frames.transpose(1, 2), self.ola, stride=self.hop)  # (1, 1, len)
        env = F.conv_transpose1d(self.win_sq.expand(1, self.win, frames.shape[1]), self.ola, stride=self.hop)
        y = y[:, 0, self.pad : -self.pad]
        env = env[:, 0, self.pad : -self.pad]
        return y / torch.clamp(env, min=1e-11)


# ---------------------------------------------------------------------------
# The transformer, split into a once-per-sentence and a per-step part
# ---------------------------------------------------------------------------


def _split_input_proj(dit, mel_dim: int):
    """Input projection Linear([x, cond, text]) -> dim, split by input."""
    w = dit.input_embed.proj.weight  # (dim, 2*mel + text)
    b = dit.input_embed.proj.bias
    return w[:, :mel_dim], w[:, mel_dim : 2 * mel_dim], w[:, 2 * mel_dim :], b


class ContextEncoder(nn.Module):
    """text ids + reference mel (zero-padded to the target length) -> context.

    Output (2, frames, dim): row 0 is the conditional branch, row 1 the
    unconditional one (no text, no reference audio), exactly what F5 feeds
    the transformer for classifier-free guidance.
    """

    def __init__(self, dit, mel_dim: int = N_MELS):
        super().__init__()
        self.text_embed = dit.text_embed
        _, w_c, w_t, b = _split_input_proj(dit, mel_dim)
        self.w_c = nn.Parameter(w_c.detach().clone(), requires_grad=False)
        self.w_t = nn.Parameter(w_t.detach().clone(), requires_grad=False)
        self.b = nn.Parameter(b.detach().clone(), requires_grad=False)

    def forward(self, text: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        # text: (1, n_text) int64, -1 padded or not; cond: (1, frames, mels)
        frames = cond.shape[1]
        t_cond = self.text_embed(text, frames, drop_text=False)
        t_null = self.text_embed(text, frames, drop_text=True)
        ctx_cond = F.linear(cond, self.w_c) + F.linear(t_cond, self.w_t) + self.b
        ctx_null = F.linear(t_null, self.w_t) + self.b
        return torch.cat([ctx_cond, ctx_null], dim=0)


class FlowStep(nn.Module):
    """One flow-matching step for B guidance branches: returns the raw velocity per branch.

    ctx is (2, frames, dim) for a guided step (conditioned + null branch,
    combined by the caller as pred + (pred - null) * cfg) or (1, frames, dim)
    for an unguided step, which costs half as much. Late steps change the
    audio little, so the app skips guidance there to save time.
    """

    def __init__(self, dit, mel_dim: int = N_MELS):
        super().__init__()
        w_x, _, _, _ = _split_input_proj(dit, mel_dim)
        self.w_x = nn.Parameter(w_x.detach().clone(), requires_grad=False)
        self.conv_pos_embed = dit.input_embed.conv_pos_embed
        self.time_embed = dit.time_embed
        self.rotary_embed = dit.rotary_embed
        self.transformer_blocks = dit.transformer_blocks
        self.norm_out = dit.norm_out
        self.proj_out = dit.proj_out

    def forward(self, x: torch.Tensor, ctx: torch.Tensor, t: torch.Tensor) -> torch.Tensor:
        # x: (1, frames, mels), ctx: (B, frames, dim), t: (1,) -> (B, frames, mels)
        seq_len = x.shape[1]
        h = F.linear(x, self.w_x) + ctx  # broadcasts x over the branches
        h = self.conv_pos_embed(h) + h
        temb = self.time_embed(t.expand(ctx.shape[0]))
        rope = self.rotary_embed.forward_from_seq_len(seq_len)
        for block in self.transformer_blocks:
            h = block(h, temb, mask=None, rope=rope)
        h = self.norm_out(h, temb)
        return self.proj_out(h)


# ---------------------------------------------------------------------------
# Sampling schedule (shared with the app)
# ---------------------------------------------------------------------------


def sway_schedule(steps: int, coef: float = -1.0) -> np.ndarray:
    """F5-TTS 'sway sampling' time points: denser early, where it matters."""
    t = np.linspace(0.0, 1.0, steps + 1, dtype=np.float64)
    if coef:
        t = t + coef * (np.cos(np.pi / 2 * t) - 1 + t)
    return t.astype(np.float32)
