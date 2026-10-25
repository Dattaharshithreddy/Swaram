"""Emotion tokens for fast voices: the same table as mobile/src/edge/emotions.ts
(EMOTION_TOKENS; CI checks they match). A training line spoken in an emotion
gets its token before the phonemes, so the model learns to speak that way
when the app puts the token in front."""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

TOKENS = {
    "happy": "1", "sad": "2", "angry": "3", "excited": "4", "calm": "5", "whisper": "6", "fearful": "7",
    "surprised": "8", "romantic": "9", "crying": "0", "laughing": "q", "shouting": "x", "serious": "z",
    "tired": "f", "nervous": "w", "proud": "y", "sarcastic": "ç", "disgusted": "ð",
}

NEUTRAL_SHARE = 0.4


def assign(data_dir: str | Path, emotions: list[str], seed: int = 0) -> dict[int, str | None]:
    """Gives each sentence an emotion (about 40% stay in the normal tone) and saves emotions.json."""
    data = Path(data_dir)
    sents = json.loads((data / "sentences.json").read_text("utf-8"))
    emotions = [e for e in emotions if e in TOKENS]
    rng = random.Random(seed)
    out: dict[int, str | None] = {}
    order = list(range(len(sents)))
    rng.shuffle(order)
    n_neutral = len(sents) if not emotions else int(len(sents) * NEUTRAL_SHARE)
    for k, i in enumerate(order):
        out[i] = None if k < n_neutral else emotions[(k - n_neutral) % len(emotions)]
    (data / "emotions.json").write_text(json.dumps({str(k): v for k, v in out.items()}), "utf-8")
    return out


def load(data_dir: str | Path) -> dict[int, str | None]:
    f = Path(data_dir) / "emotions.json"
    if not f.exists():
        return {}
    return {int(k): v for k, v in json.loads(f.read_text("utf-8")).items()}


if __name__ == "__main__":
    # python emotions.py DATA_DIR happy,sad,...
    got = assign(sys.argv[1], [e for e in (sys.argv[2] if len(sys.argv) > 2 else "").split(",") if e])
    counts: dict[str, int] = {}
    for v in got.values():
        counts[v or "normal"] = counts.get(v or "normal", 0) + 1
    print(counts)
