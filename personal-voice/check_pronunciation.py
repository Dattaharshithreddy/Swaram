"""Listen to every training take and score how well it says its sentence.

The fast voice learns from speech the big model made. When that speech skips
or garbles a word, the fast voice learns the mistake, and the length check in
dataset.py can't see it. This step transcribes each take with a Telugu speech
recogniser and stores the character error rate (CER) against the sentence;
dataset.py then leaves out the takes that don't match.

    python check_pronunciation.py DATA [--model vasista22/whisper-telugu-large-v2]

Writes DATA/asr.json: {"s00012": {"heard": "...", "cer": 0.04}, ...}.
Resumable: takes already in asr.json are not transcribed again.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import time
import unicodedata
from pathlib import Path

DEFAULT_MODEL = "vasista22/whisper-telugu-large-v2"
_TELUGU = re.compile(r"[ఀ-౿]")
_INDIC_TEXT = Path(__file__).resolve().parent.parent / "backend" / "utils" / "indic_text.py"


def _expand_numbers():
    """The backend's Telugu number speller, loaded by path (no backend imports)."""
    try:
        spec = importlib.util.spec_from_file_location("swaram_indic_text", _INDIC_TEXT)
        mod = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(mod)
        return lambda text: mod.expand_numbers(text, "te")
    except Exception:  # noqa: BLE001 - spelling digits is optional
        return lambda text: text


def normalize(text: str, expand=lambda t: t) -> str:
    """Telugu letters only, no spaces or punctuation: spacing and full stops
    differ between recognisers and don't change pronunciation."""
    text = unicodedata.normalize("NFC", expand(text)).replace("‌", "").replace("‍", "")
    return "".join(ch for ch in text if _TELUGU.match(ch))


def edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(reference: str, heard: str, expand=lambda t: t) -> float:
    ref = normalize(reference)
    hyp = normalize(heard, expand)  # the recogniser may write digits; spell them like the sentence
    if not ref:
        return 0.0
    return edit_distance(ref, hyp) / len(ref)


def load_16k(path: Path):
    import librosa

    audio, _ = librosa.load(str(path), sr=16000, mono=True)
    return audio


def make_recogniser(model: str, batch: int):
    import torch
    from transformers import pipeline

    cuda = torch.cuda.is_available()
    pipe = pipeline(
        "automatic-speech-recognition",
        model=model,
        device=0 if cuda else -1,
        torch_dtype=torch.float16 if cuda else torch.float32,
    )

    def transcribe(audios: list) -> list[str]:
        inputs = [{"raw": a, "sampling_rate": 16000} for a in audios]
        try:
            out = pipe(inputs, batch_size=batch, generate_kwargs={"language": "telugu", "task": "transcribe"})
        except (ValueError, TypeError):  # some fine-tunes fix the language in their config
            out = pipe(inputs, batch_size=batch)
        return [o["text"] for o in out]

    return transcribe


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("data")
    p.add_argument("--model", default=DEFAULT_MODEL)
    p.add_argument("--batch", type=int, default=16)
    args = p.parse_args()

    data = Path(args.data)
    sents = json.loads((data / "sentences.json").read_text("utf-8"))
    out_path = data / "asr.json"
    results: dict = json.loads(out_path.read_text("utf-8")) if out_path.exists() else {}
    todo = [(i, s) for i, s in enumerate(sents) if (data / "wav" / f"s{i:05d}.wav").exists() and f"s{i:05d}" not in results]
    print(f"Checking {len(todo)} takes with {args.model} ({len(results)} already checked)", flush=True)
    if not todo:
        return

    expand = _expand_numbers()
    transcribe = make_recogniser(args.model, args.batch)
    t0 = time.time()
    for start in range(0, len(todo), args.batch):
        chunk = todo[start : start + args.batch]
        heard = transcribe([load_16k(data / "wav" / f"s{i:05d}.wav") for i, _ in chunk])
        for (i, s), h in zip(chunk, heard, strict=True):
            results[f"s{i:05d}"] = {"heard": h, "cer": round(cer(s, h, expand), 4)}
        out_path.write_text(json.dumps(results, ensure_ascii=False), "utf-8")
        done = start + len(chunk)
        print(f"  {done}/{len(todo)} ({(time.time() - t0) / done:.2f} s per take)", flush=True)

    scores = sorted(r["cer"] for r in results.values())
    print(f"Median CER {scores[len(scores) // 2]:.3f}; worst takes:")
    for key, r in sorted(results.items(), key=lambda kv: -kv[1]["cer"])[:5]:
        print(f"  {key} CER {r['cer']:.2f}: heard {r['heard'][:80]!r}")


if __name__ == "__main__":
    main()
