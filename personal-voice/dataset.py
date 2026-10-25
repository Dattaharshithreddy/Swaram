"""Training CSV for Piper: wav|phonemes, from the generated audio."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import soundfile as sf

import emotions
from telugu_ipa import phonemize


def main(data_dir: str) -> None:
    data = Path(data_dir)
    sents = json.loads((data / "sentences.json").read_text("utf-8"))
    assigned = emotions.load(data)
    rows, seconds = [], 0.0
    used: dict[str, int] = {}
    for i, s in enumerate(sents):
        wav = data / "wav" / f"s{i:05d}.wav"
        if not wav.exists():
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


if __name__ == "__main__":
    main(sys.argv[1])
