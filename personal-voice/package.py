"""Export the trained voice to ONNX and pack it for the Swaram app.

    python package.py --train train --piper piper1-gpl --name Amma --out output
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import unicodedata
import zipfile
from pathlib import Path

import numpy as np

from telugu_ipa import phonemize

SAMPLES = [
    "నమస్కారం, ఇది నా సొంత గొంతు, ఫోన్‌లోనే తయారైంది.",
    "ఈ రోజు మనం ఒక కొత్త విషయం నేర్చుకుందాం.",
    "మీకు ఈ వీడియో నచ్చితే, లైక్ చేసి షేర్ చేయండి.",
]


def latest_checkpoint(train: Path) -> Path:
    ckpts = sorted(train.rglob("last.ckpt"), key=lambda p: p.stat().st_mtime)
    if not ckpts:
        ckpts = sorted(train.rglob("*.ckpt"), key=lambda p: p.stat().st_mtime)
    if not ckpts:
        raise FileNotFoundError(f"No checkpoint under {train}")
    return ckpts[-1]


def phoneme_ids(text: str, id_map: dict) -> list[int]:
    ids = [id_map["^"][0], id_map["_"][0]]
    for ph in unicodedata.normalize("NFD", phonemize(text)):
        if ph in id_map:
            ids += [id_map[ph][0], id_map["_"][0]]
    return ids + [id_map["$"][0]]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--train", required=True)
    p.add_argument("--piper", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--out", required=True)
    args = p.parse_args()

    train, out = Path(args.train).resolve(), Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    ckpt = latest_checkpoint(train)
    model = out / "model.onnx"
    env = dict(os.environ, PYTHONPATH=f"{Path(args.piper).resolve() / 'src'}:{os.environ.get('PYTHONPATH', '')}")
    subprocess.run(
        [sys.executable, "-m", "piper.train.export_onnx", "--checkpoint", str(ckpt), "--output-file", str(model)],
        check=True,
        env=env,
    )
    config = json.loads((train / "config.json").read_text("utf-8"))
    voice = {
        "format": "swaram-personal/1",
        "name": args.name,
        "language": "te",
        "sample_rate": config["audio"]["sample_rate"],
        "phonemizer": "swaram-te-ipa/1",
        "created": int(time.time()),
        "checkpoint": ckpt.name,
    }
    (out / "voice.json").write_text(json.dumps(voice, ensure_ascii=False, indent=1), "utf-8")
    (out / "config.json").write_text(json.dumps(config, ensure_ascii=False), "utf-8")

    # A few samples to listen to before importing.
    import onnxruntime as ort
    import soundfile as sf

    sess = ort.InferenceSession(str(model))
    inf = config.get("inference", {})
    scales = np.array([inf.get("noise_scale", 0.667), inf.get("length_scale", 1.0), inf.get("noise_w", 0.8)], dtype=np.float32)
    (out / "samples").mkdir(exist_ok=True)
    for i, text in enumerate(SAMPLES):
        ids = np.array([phoneme_ids(text, config["phoneme_id_map"])], dtype=np.int64)
        t0 = time.time()
        wav = sess.run(None, {"input": ids, "input_lengths": np.array([ids.shape[1]], dtype=np.int64), "scales": scales})[0].squeeze()
        print(f"sample {i + 1}: {wav.size / voice['sample_rate']:.1f} s of audio in {time.time() - t0:.2f} s")
        sf.write(out / "samples" / f"sample{i + 1}.wav", wav, voice["sample_rate"])

    safe = "".join(c if c.isalnum() else "-" for c in args.name).strip("-") or "voice"
    pack = out / f"swaram-voice-{safe}.zip"
    with zipfile.ZipFile(pack, "w", zipfile.ZIP_DEFLATED) as z:
        for name in ("voice.json", "config.json", "model.onnx"):
            z.write(out / name, name)
    print(f"Voice pack: {pack} ({pack.stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
