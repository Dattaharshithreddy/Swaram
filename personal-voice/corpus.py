"""Telugu sentences for the training script: everyday lines plus Wikipedia."""

from __future__ import annotations

import random
import re
from pathlib import Path

ALLOWED = re.compile(r"[ఀ-౿‌‍ ,;:.?!]+")
SPLIT = re.compile(r"(?<=[.?!।])\s+")


def clean(s: str) -> str | None:
    s = re.sub(r"\s+", " ", s.replace("।", ".")).strip()
    s = re.sub(r"\s*\([^)]*\)", "", s)  # drop bracketed asides
    if not s or not ALLOWED.fullmatch(s):
        return None
    if not 25 <= len(s) <= 150 or len(s.split()) < 3:
        return None
    if s[-1] not in ".?!":
        s += "."
    return s


def everyday() -> list[str]:
    """Built-in conversational lines: everyday.txt plus the studio-voice reading list."""
    out: list[str] = []
    for f in (Path(__file__).parent / "everyday.txt", Path(__file__).parent.parent / "cloud" / "pro_sentences.txt"):
        if f.exists():
            out += [line.strip() for line in f.read_text("utf-8").splitlines() if line.strip()]
    return list(dict.fromkeys(out))


def wikipedia(n: int, seed: int = 0) -> list[str]:
    from datasets import load_dataset

    ds = load_dataset("wikimedia/wikipedia", "20231101.te", split="train", streaming=True)
    seen: set[str] = set()
    out: list[str] = []
    for article in ds.shuffle(seed=seed, buffer_size=2000):
        for raw in SPLIT.split(article["text"]):
            s = clean(raw)
            if s and s not in seen:
                seen.add(s)
                out.append(s)
        if len(out) >= n * 3:
            break
    random.Random(seed).shuffle(out)
    return out[:n]


def sentences(n: int, seed: int = 0, timeout: float = 900) -> list[str]:
    base = everyday()
    if n <= len(base):
        return base[:n]
    # Wikipedia streaming can hang; give it a time limit (a daemon thread, so a stuck
    # download can't keep the script from exiting) and fall back to the built-in lines.
    import threading

    box: dict[str, object] = {}

    def fetch() -> None:
        try:
            box["ok"] = wikipedia(n - len(base), seed)
        except Exception as e:  # offline tests: built-in lines only
            box["err"] = e

    th = threading.Thread(target=fetch, daemon=True)
    th.start()
    th.join(timeout)
    if "ok" in box:
        extra = box["ok"]  # type: ignore[assignment]
    else:
        why = box.get("err") or f"took over {timeout:.0f} s"
        print(f"Wikipedia not available ({why}); using {len(base)} built-in sentences only", flush=True)
        extra = []
    return (base + extra)[:n]
