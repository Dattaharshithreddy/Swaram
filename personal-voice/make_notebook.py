"""Builds swaram_personal_voice.ipynb (the Kaggle notebook) from the cells below."""

import json
from pathlib import Path

PIPER_COMMIT = "74ac24e7e8e2e57a5e1fada5505c74e3d9c1843a"

cells = [
    ("markdown", """# Swaram: train your personal fast voice (free, on Kaggle)

This makes a small voice model of **one person** that runs on your phone
about 20 times faster than real time, offline.

**Before you run:**
1. In the app: Offline → your voice → **Export for training**. Upload that `.zip` here with
   **+ Add Input → Upload → New Dataset**.
2. **Settings → Accelerator → GPU T4 x2**, and **Internet → On**.
3. **Add-ons → Secrets**: a secret named `HF_TOKEN` with your Hugging Face token, switched on for this notebook.
4. Click **Save Version → Save & Run All (Commit)**. It runs in the background for about 4 hours;
   you can close the browser.

**After:** open the saved version → **Output** → download `swaram-voice-….zip` (about 60 MB) to your
phone, then in the app: Offline → **Import personal voice**. Listen to `samples/` first if you like."""),
    ("code", """# Settings (the defaults are fine)
SENTENCES = 1500      # how much training speech to make (about 1.5-2 hours of audio)
TRAIN_HOURS = 2.5     # training time; more = a bit better
STEPS = 32            # quality of the training speech (big model steps)
VOICE_NAME = ""       # leave empty to use the name from the app
REF_TEXT = ""         # only if you uploaded a plain audio file instead of the app's export"""),
    ("code", f"""# 1. Setup (about 5 minutes)
import os, subprocess, sys, glob, json, shlex, zipfile

if not os.environ.get("HF_TOKEN"):  # the app passes it directly; by hand it's a Kaggle secret
    from kaggle_secrets import UserSecretsClient
    os.environ["HF_TOKEN"] = UserSecretsClient().get_secret("HF_TOKEN")
WORK = "/tmp/swaram"          # big intermediate files (not kept)
OUT = "/kaggle/working/output" # what you download
os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)

def sh(cmd):
    print("$", cmd, flush=True)
    subprocess.run(f"set -o pipefail; {{cmd}}", shell=True, check=True, executable="/bin/bash")

sh(f"git clone -q --depth 1 https://github.com/Dattaharshithreddy/Swaram.git {{WORK}}/Swaram || true")
sh(f"git clone -q --depth 1 https://github.com/AI4Bharat/IndicF5.git {{WORK}}/IndicF5 || true")
sh(f"git clone -q https://github.com/OHF-Voice/piper1-gpl.git {{WORK}}/piper || true")
sh(f"cd {{WORK}}/piper && git checkout -q {PIPER_COMMIT}")
sh("pip install -q x-transformers torchdiffeq vocos==0.1.0 einops jieba pypinyin ema-pytorch onnx onnxruntime pathvalidate "
   "'lightning>=2,<3' 'jsonargparse[signatures]>=4.27.7' tensorboardX 'pysilero-vad>=2.1,<3' 'cython>=3,<4'")
sh(f"cd {{WORK}}/piper && bash build_monotonic_align.sh")
PV = f"{{WORK}}/Swaram/personal-voice"
os.environ["PYTHONPATH"] = f"{{WORK}}/IndicF5:{{WORK}}/Swaram/edge"
import torch; print("GPUs:", torch.cuda.device_count())
assert torch.cuda.is_available(), "Turn on the GPU: Settings -> Accelerator -> GPU T4 x2"
"""),
    ("code", """# 2. Find the voice you uploaded (or the one the app sent)
ref_wav, ref_text, name = None, REF_TEXT, VOICE_NAME
emotion_refs = {}
if "APP_VOICE" in globals():
    import base64
    os.makedirs(f"{WORK}/voice", exist_ok=True)
    open(f"{WORK}/voice/ref.wav", "wb").write(base64.b64decode(APP_VOICE["wav_base64"]))
    emos = {}
    for e, v in (APP_VOICE.get("emotions") or {}).items():
        open(f"{WORK}/voice/emo-{e}.wav", "wb").write(base64.b64decode(v["wav_base64"]))
        emos[e] = {"audio": f"emo-{e}.wav", "text": v["text"]}
    meta = {k: v for k, v in APP_VOICE.items() if k not in ("wav_base64", "emotions")}
    json.dump(meta | {"audio": "ref.wav", "emotions": emos}, open(f"{WORK}/voice/voice.json", "w"))
for z in glob.glob("/kaggle/input/**/*.zip", recursive=True):
    with zipfile.ZipFile(z) as f:
        f.extractall(f"{WORK}/voice")
for meta in glob.glob(f"{WORK}/voice/**/voice.json", recursive=True) + glob.glob("/kaggle/input/**/voice.json", recursive=True):
    info = json.load(open(meta))
    ref_wav = os.path.join(os.path.dirname(meta), info.get("audio", "ref.wav"))
    ref_text = ref_text or info["text"]
    name = name or info.get("name", "")
    emotion_refs = {e: (os.path.join(os.path.dirname(meta), v["audio"]), v["text"]) for e, v in (info.get("emotions") or {}).items()}
    break
if not ref_wav:
    wavs = [p for p in glob.glob("/kaggle/input/**/*", recursive=True) if p.lower().endswith((".wav", ".mp3", ".m4a", ".ogg", ".opus", ".flac"))]
    assert wavs, "No voice found. Upload the app's 'Export for training' zip (+ Add Input)."
    ref_wav = wavs[0]
assert ref_text, "Set REF_TEXT (exactly what is said in the recording) in the settings cell."
name = name or "My voice"
print("Voice:", name, "|", ref_wav, "|", ref_text)
print("Emotions:", ", ".join(emotion_refs) or "none (normal tone only)")
"""),
    ("code", """# 3. Make the training speech with the big model (about 30-60 minutes on 2 GPUs)
DATA = f"{WORK}/data"
sh(f"cd {PV} && python make_sentences.py {DATA} {SENTENCES}")
# Share the sentences between the normal tone and each emotion recording.
sh(f"cd {PV} && python emotions.py {DATA} {','.join(emotion_refs)}")
n = max(1, torch.cuda.device_count())
tones = [(None, ref_wav, ref_text)] + [(e, w, t) for e, (w, t) in emotion_refs.items()]
for tone, wav, text in tones:
    procs = []
    for i in range(n):
        cmd = (f"cd {PV} && CUDA_VISIBLE_DEVICES={i} python generate.py --ref {shlex.quote(wav)} --ref-text {shlex.quote(text)} "
               f"--emotion {shlex.quote(tone or '')} --out {DATA} --steps {STEPS} --batch 8 --shard {i}/{n} > {WORK}/gen{i}.log 2>&1")
        procs.append(subprocess.Popen(cmd, shell=True, executable="/bin/bash"))
    for p in procs:
        p.wait()
    print(f"--- {tone or 'normal tone'} ---")
    for i in range(n):
        print(open(f"{WORK}/gen{i}.log").read()[-300:])
    assert all(p.returncode == 0 for p in procs), "Generation failed: see the log above"
sh(f"cd {PV} && python dataset.py {DATA}")
"""),
    ("code", """# 4. Train the small fast model (TRAIN_HOURS)
TRAIN = f"{WORK}/train"
sh(f"cd {PV} && python train.py --data {DATA} --piper {WORK}/piper --out {TRAIN} --hours {TRAIN_HOURS} --batch 16 2>&1 | grep -v Warning | tail -n 40")
"""),
    ("code", """# 5. Package it for the app
sh(f"cd {PV} && python package.py --train {TRAIN} --piper {WORK}/piper --name {shlex.quote(name)} --data {DATA} --out {OUT}")
for f in ("model.onnx", "config.json", "voice.json"):
    os.remove(f"{OUT}/{f}")  # they are inside the zip
print("Done! Download from the Output tab:", os.listdir(OUT))
from IPython.display import Audio, display
for s in sorted(glob.glob(f"{OUT}/samples/*.wav")):
    display(Audio(s))
"""),
]

nb = {
    "cells": [
        {"cell_type": t, "metadata": {}, "source": src.splitlines(keepends=True), **({"outputs": [], "execution_count": None} if t == "code" else {})}
        for t, src in cells
    ],
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python"},
        "kaggle": {"accelerator": "nvidiaTeslaT4", "isInternetEnabled": True, "isGpuEnabled": True},
    },
    "nbformat": 4,
    "nbformat_minor": 4,
}
Path(__file__).with_name("swaram_personal_voice.ipynb").write_text(json.dumps(nb, indent=1, ensure_ascii=False), "utf-8")
print("wrote swaram_personal_voice.ipynb")
