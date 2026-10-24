"""The phone pipeline must produce what the original IndicF5 code produces.

Uses a 2-layer model with random weights so it runs on any CPU in about a
minute; the graph structure is identical to the full 22-layer model.

    cd edge && PYTHONPATH=.:../path/to/IndicF5 pytest tests -q
"""

from __future__ import annotations

import numpy as np
import pytest
import torch

from swaram_edge.export import export_all
from swaram_edge.f5 import F5Config, build_dit
from swaram_edge.graphs import sway_schedule as torch_sway
from swaram_edge.runner import EdgeTTS, Voice, normalize_ref_text, sway_schedule
from swaram_edge.vocos_loader import build_vocos_24khz

VOCAB = [" ", ".", ","] + [chr(c) for c in range(0x0C00, 0x0C80)]


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    torch.manual_seed(0)
    cfg = F5Config(depth=2, vocab_size=len(VOCAB))
    dit = build_dit(cfg)
    vocos = build_vocos_24khz()
    out = tmp_path_factory.mktemp("edge")
    export_all(dit, cfg, vocos, VOCAB, out, quantize_int8=True)
    return dit, vocos, out


def _wav(seconds=2.0, sr=24000):
    t = np.arange(int(seconds * sr)) / sr
    return (0.2 * np.sin(2 * np.pi * 180 * t) * (1 + 0.5 * np.sin(2 * np.pi * 3 * t))).astype(np.float32)


def test_mel_matches_torchaudio(built):
    from f5_tts.model.modules import get_vocos_mel_spectrogram

    _, _, out = built
    tts = EdgeTTS(out, int8=False)
    wav = _wav()
    ours = tts.mel.run(None, {"wav": wav[None]})[0][0]
    ref = get_vocos_mel_spectrogram(torch.from_numpy(wav)[None]).squeeze(0).T.numpy()
    assert ours.shape == ref.shape
    # Near-silent bins (log values around -11) differ by float rounding that
    # the log magnifies; compare audible bins in log space and all in linear.
    audible = ref > -5
    np.testing.assert_allclose(ours[audible], ref[audible], atol=2e-3)
    assert np.abs(np.exp(ours) - np.exp(ref)).max() / np.exp(ref).max() < 1e-5


def test_vocoder_matches_vocos(built):
    _, vocos, out = built
    tts = EdgeTTS(out, int8=False)
    mel = np.random.default_rng(1).standard_normal((1, 100, 80)).astype(np.float32) * 0.5 - 4
    ours = tts.vocoder.run(None, {"mel": mel})[0]
    with torch.no_grad():
        ref = vocos.decode(torch.from_numpy(mel)).numpy()
    assert ours.shape == ref.shape
    np.testing.assert_allclose(ours, ref, atol=1e-4, rtol=1e-3)


def test_schedule_matches():
    np.testing.assert_allclose(sway_schedule(16), torch_sway(16), atol=1e-7)


def test_ref_text_rule_matches_f5():
    assert normalize_ref_text("నమస్కారం") == "నమస్కారం. "
    assert normalize_ref_text("నమస్కారం.") == "నమస్కారం. "


def test_full_sampling_matches_f5_cfm(built):
    """End to end against f5_tts CFM.sample with identical noise."""
    from f5_tts.model.cfm import CFM

    dit, _, out = built
    tts = EdgeTTS(out, int8=False)
    rng = np.random.default_rng(3)
    ref_mel = rng.standard_normal((90, 100)).astype(np.float32) - 3
    voice = Voice(mel=ref_mel, text=normalize_ref_text("నమస్కారం అండీ"), rms=0.2)
    gen = "ఎలా ఉన్నారు, బాగున్నారా."
    steps, cfg_strength, seed = 8, 2.0, 7

    ref_frames = ref_mel.shape[0]
    duration = ref_frames + int(ref_frames / len(voice.text.encode()) * len(gen.encode()))

    vocab_map = {c: i for i, c in enumerate(VOCAB)}
    cfm = CFM(transformer=dit, vocab_char_map=vocab_map).eval()
    torch.manual_seed(seed)
    noise = torch.randn(duration, 100).numpy()
    with torch.no_grad():
        ref_out, _ = cfm.sample(
            cond=torch.from_numpy(ref_mel)[None],
            text=[voice.text + gen],
            duration=duration,
            steps=steps,
            cfg_strength=cfg_strength,
            sway_sampling_coef=-1.0,
            seed=seed,
        )
    ours = tts.speak_chunk(voice, gen, steps=steps, cfg=cfg_strength, noise=noise, return_mel=True)
    ref_out = ref_out[0].numpy()
    assert ours.shape == ref_out.shape
    np.testing.assert_allclose(ours, ref_out, atol=2e-3, rtol=1e-3)


def test_int8_stays_close(built):
    _, _, out = built
    fp = EdgeTTS(out, int8=False)
    q = EdgeTTS(out, int8=True)
    rng = np.random.default_rng(5)
    voice = Voice(mel=rng.standard_normal((60, 100)).astype(np.float32) - 3, text="నమస్కారం. ", rms=0.2)
    a = fp.speak_chunk(voice, "బాగున్నారా", steps=4, seed=1, return_mel=True)
    b = q.speak_chunk(voice, "బాగున్నారా", steps=4, seed=1, return_mel=True)
    rel = np.linalg.norm(a - b) / np.linalg.norm(a)
    assert rel < 0.1, rel


def test_voice_roundtrip(tmp_path, built):
    _, _, out = built
    tts = EdgeTTS(out)
    voice = tts.make_voice(_wav(3.0), "నమస్కారం")
    path = tmp_path / "v.npz"
    voice.save(path)
    again = Voice.load(path)
    assert again.text == voice.text
    np.testing.assert_allclose(again.mel, voice.mel, atol=1e-2)
    wav, timing = tts.speak(again, "ఎలా ఉన్నారు.", steps=4, seed=0)
    assert wav.dtype == np.float32
    assert wav.size > 0
    assert timing.audio_seconds > 0
