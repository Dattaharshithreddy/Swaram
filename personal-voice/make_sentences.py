"""Pick the training sentences once (before generating on several GPUs)."""

import json
import sys
from pathlib import Path

import corpus

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
sents = corpus.sentences(int(sys.argv[2]))
(out / "sentences.json").write_text(json.dumps(sents, ensure_ascii=False, indent=0), "utf-8")
print(f"{len(sents)} sentences")
