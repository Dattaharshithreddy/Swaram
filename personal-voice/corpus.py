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
    return [line.strip() for line in (Path(__file__).parent / "everyday.txt").read_text("utf-8").splitlines() if line.strip()]


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


def sentences(n: int, seed: int = 0) -> list[str]:
    base = everyday()
    try:
        extra = wikipedia(max(0, n - len(base)), seed)
    except Exception as e:  # offline tests: everyday lines only
        print(f"Wikipedia not available ({e}); using built-in sentences only")
        extra = []
    return (base + extra)[:n]
