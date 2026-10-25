"""Writes swaram_render.ipynb, the Kaggle notebook the app runs to render a
script at the highest quality on a free GPU. The app inserts an APP_RENDER cell
with the voices and lines (see mobile/src/edge/kaggleRender.ts).

    python make_notebook.py
"""

import json
from pathlib import Path

CELLS = [
    ("markdown", """# Swaram: render a script at studio quality

Started by the Swaram app. It makes every line with the full IndicF5 model at
32 steps on Kaggle's free GPU and saves them for the app to download
(`swaram-render.zip` in the Output tab). Usually 10-20 minutes."""),
    ("code", """# 1. Setup (about 5 minutes)
import os, subprocess, glob, json, base64, zipfile
if not os.environ.get("HF_TOKEN"):
    from kaggle_secrets import UserSecretsClient
    os.environ["HF_TOKEN"] = UserSecretsClient().get_secret("HF_TOKEN")
WORK = "/tmp/render"
OUT = "/kaggle/working"
os.makedirs(WORK, exist_ok=True)

def sh(cmd):
    print("$", cmd, flush=True)
    subprocess.run(f"set -o pipefail; {cmd}", shell=True, check=True, executable="/bin/bash")

sh(f"git clone -q --depth 1 https://github.com/Dattaharshithreddy/Swaram.git {WORK}/Swaram || true")
sh(f"git clone -q --depth 1 https://github.com/AI4Bharat/IndicF5.git {WORK}/IndicF5 || true")
sh("pip install -q x-transformers torchdiffeq vocos==0.1.0 einops jieba pypinyin ema-pytorch librosa soundfile safetensors")
os.environ["PYTHONPATH"] = f"{WORK}/IndicF5:{WORK}/Swaram/edge"
import torch; print("GPU:", torch.cuda.is_available())
"""),
    ("code", """# 2. The voices and lines the app sent
assert "APP_RENDER" in globals(), "Start this from the Swaram app (Studio -> project -> Render on Kaggle)."
job = {"steps": APP_RENDER.get("steps", 32), "cfg": APP_RENDER.get("cfg", 2.0), "voices": {}, "parts": APP_RENDER["parts"]}
os.makedirs(f"{WORK}/job", exist_ok=True)
for key, v in APP_RENDER["voices"].items():
    name = f"voice-{len(job['voices'])}.wav"
    open(f"{WORK}/job/{name}", "wb").write(base64.b64decode(v["wav_base64"]))
    entry = {"wav": name, "text": v["text"]}
    if v.get("ckpt_name"):
        # A voice trained on the big model: its weights come from that training run's output.
        found = glob.glob(f"/kaggle/input/**/{v['ckpt_name']}", recursive=True)
        if found:
            entry["ckpt"] = os.path.relpath(found[0], f"{WORK}/job")
        else:
            print("Trained model not found for", key, "- using the normal model")
    job["voices"][key] = entry
json.dump(job, open(f"{WORK}/job/job.json", "w"), ensure_ascii=False)
print(len(job["parts"]), "lines,", len(job["voices"]), "voices,", job["steps"], "steps")
"""),
    ("code", """# 3. Make every line
sh(f"cd {WORK}/Swaram/cloud && python render.py --job {WORK}/job/job.json --out {WORK}/out")
with zipfile.ZipFile(f"{OUT}/swaram-render.zip", "w") as z:
    for f in sorted(glob.glob(f"{WORK}/out/parts/*.wav")) + [f"{WORK}/out/render.json"]:
        z.write(f, os.path.basename(f))
print("Done:", os.path.getsize(f"{OUT}/swaram-render.zip") // 1024, "KB")
"""),
]


def main() -> None:
    nb = {
        "cells": [
            {"cell_type": t, "metadata": {}, "source": src.splitlines(keepends=True),
             **({"outputs": [], "execution_count": None} if t == "code" else {})}
            for t, src in CELLS
        ],
        "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                     "language_info": {"name": "python"}},
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    out = Path(__file__).with_name("swaram_render.ipynb")
    out.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n", "utf-8")
    print("wrote", out.name)


if __name__ == "__main__":
    main()
