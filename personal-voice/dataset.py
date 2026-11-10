"""Training CSV for Piper: wav|phonemes, from the generated audio."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import emotions
import soundfile as sf
from telugu_ipa import phonemize

# Takes whose transcript differs from the sentence by more than this (character
# error rate, from check_pronunciation.py) are left out of training.
MAX_CER = float(os.environ.get("SWARAM_MAX_CER", "0.15"))
# ...but never drop more than this share: if the recogniser itself struggles,
# losing most of the data would hurt more than a few imperfect takes.
MIN_KEEP = 0.6


def cer_limit(scores: list[float]) -> float:
    """MAX_CER, raised just enough to keep at least MIN_KEEP of the takes."""
    if not scores:
        return float("inf")
    ordered = sorted(scores)
    keep_floor = ordered[min(len(ordered) - 1, int(len(ordered) * MIN_KEEP))]
    return max(MAX_CER, keep_floor)


def main(data_dir: str) -> None:
    data = Path(data_dir)
    sents = json.loads((data / "sentences.json").read_text("utf-8"))
    assigned = emotions.load(data)
    asr_path = data / "asr.json"
    asr = json.loads(asr_path.read_text("utf-8")) if asr_path.exists() else {}
    limit = cer_limit([r["cer"] for r in asr.values()])
    if asr:
        print(f"Pronunciation check: leaving out takes with CER above {limit:.2f}")
        if limit > MAX_CER:
            print(f"  (raised from {MAX_CER:.2f} so at least {MIN_KEEP:.0%} of the takes stay)")
    rows, seconds = [], 0.0
    used: dict[str, int] = {}
    mispronounced = 0
    for i, s in enumerate(sents):
        wav = data / "wav" / f"s{i:05d}.wav"
        if not wav.exists():
            continue
        check = asr.get(wav.stem)
        if check is not None and check["cer"] > limit:
            mispronounced += 1
            continue
        info = sf.info(str(wav))
        dur = info.frames / info.samplerate
        # Drop takes whose length doesn't fit the text (the big model sometimes rushes or drags).
        per_char = dur / max(1, len(s))
        if not 0.03 <= per_char <= 0.2 or dur > 15:
            continue
        e = assigned.get(i)
        # The emotion's token first (the app adds the same one), then the phonemes.
        rows.append(f"{wav.name}|{emotions.TOKENS[e] + ' ' if e else ''}{phonemize(s)}")
        if e:
            used[e] = used.get(e, 0) + 1
        seconds += dur
    (data / "metadata.csv").write_text("\n".join(rows) + "\n", "utf-8")
    (data / "emotions_used.json").write_text(json.dumps(used), "utf-8")
    print(f"{len(rows)} clips, {seconds / 60:.1f} minutes of audio, emotions: {used or 'none'}")
    if asr:
        print(f"Left out {mispronounced} takes that didn't match their sentence")


if __name__ == "__main__":
    main(sys.argv[1])
