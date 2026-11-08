"""
Indic Parler-TTS worker process.

Runs in its own Python environment because ``parler_tts`` pins
``transformers==4.46.1`` while the rest of Swaram needs 4.57. The server
starts it on first use (see ``indic_parler_backend.py``) and talks to it with
one JSON object per line:

    -> {"id": 1, "op": "load"}
    <- {"id": 1, "ok": true, "device": "cuda:0", "sample_rate": 44100}
    -> {"id": 2, "op": "generate", "texts": ["..."], "description": "...",
        "seed": 7, "out": "/tmp/x.wav"}
    <- {"id": 2, "ok": true, "out": "/tmp/x.wav", "sample_rate": 44100,
        "seconds": 3.2}

All sentences of a request are generated in one padded batch, which is
where most of the speed comes from. This file imports nothing from the
Swaram package so it can run under any interpreter.

Setup (one time):  just setup-parler   (or see docs in indic_parler_backend.py)
"""

from __future__ import annotations

import json
import os
import sys

REPO = os.environ.get("SWARAM_PARLER_REPO", "ai4bharat/indic-parler-tts")
PAUSE_SECONDS = 0.18

_proto = sys.stdout
sys.stdout = sys.stderr  # library prints must never corrupt the protocol

_state: dict = {}


def _reply(obj: dict) -> None:
    _proto.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _proto.flush()


def _load() -> dict:
    if "model" in _state:
        return _state
    import torch
    from parler_tts import ParlerTTSForConditionalGeneration
    from transformers import AutoTokenizer

    if torch.cuda.is_available():
        device = "cuda:0"
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        device, dtype = "mps", torch.float32
    else:
        device, dtype = "cpu", torch.float32
        torch.set_num_threads(min(os.cpu_count() or 4, 8))

    kwargs = {"torch_dtype": dtype}
    try:
        model = ParlerTTSForConditionalGeneration.from_pretrained(REPO, attn_implementation="sdpa", **kwargs)
    except (TypeError, ValueError):
        model = ParlerTTSForConditionalGeneration.from_pretrained(REPO, **kwargs)
    model = model.to(device).eval()
    tokenizer = AutoTokenizer.from_pretrained(REPO)
    desc_tokenizer = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)
    _state.update(
        model=model,
        tokenizer=tokenizer,
        desc_tokenizer=desc_tokenizer,
        device=device,
        sample_rate=int(model.config.sampling_rate),
    )
    return _state


def _generate(texts: list[str], description: str, seed: int | None, out: str) -> dict:
    import numpy as np
    import soundfile as sf
    import torch

    st = _load()
    model, device, sr = st["model"], st["device"], st["sample_rate"]
    if seed is not None:
        torch.manual_seed(seed)
        if device.startswith("cuda"):
            torch.cuda.manual_seed_all(seed)

    desc = st["desc_tokenizer"]([description] * len(texts), return_tensors="pt", padding=True).to(device)
    prompt = st["tokenizer"](texts, return_tensors="pt", padding=True).to(device)

    pieces: list[np.ndarray] = []
    with torch.inference_mode():
        gen = model.generate(
            input_ids=desc.input_ids,
            attention_mask=desc.attention_mask,
            prompt_input_ids=prompt.input_ids,
            prompt_attention_mask=prompt.attention_mask,
            do_sample=True,
            return_dict_in_generate=True,
        )
        seqs = getattr(gen, "sequences", gen)
        lengths = getattr(gen, "audios_length", None)
        for i in range(seqs.shape[0]):
            row = seqs[i]
            if lengths is not None:
                row = row[: int(lengths[i])]
            pieces.append(row.float().cpu().numpy().squeeze())

    gap = np.zeros(int(PAUSE_SECONDS * sr), dtype=np.float32)
    joined: list[np.ndarray] = []
    for i, p in enumerate(pieces):
        if i:
            joined.append(gap)
        joined.append(np.asarray(p, dtype=np.float32))
    audio = np.concatenate(joined) if joined else np.zeros(0, dtype=np.float32)
    sf.write(out, audio, sr)
    return {"out": out, "sample_rate": sr, "seconds": len(audio) / sr}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req: dict = {}
        try:
            req = json.loads(line)
            op = req.get("op")
            if op == "ping":
                _reply({"id": req.get("id"), "ok": True})
            elif op == "load":
                st = _load()
                _reply({"id": req.get("id"), "ok": True, "device": st["device"], "sample_rate": st["sample_rate"]})
            elif op == "generate":
                res = _generate(req["texts"], req["description"], req.get("seed"), req["out"])
                _reply({"id": req.get("id"), "ok": True, **res})
            elif op == "shutdown":
                _reply({"id": req.get("id"), "ok": True})
                return
            else:
                _reply({"id": req.get("id"), "ok": False, "error": f"unknown op {op!r}"})
        except Exception as exc:  # report, keep serving
            _reply({"id": req.get("id"), "ok": False, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()
