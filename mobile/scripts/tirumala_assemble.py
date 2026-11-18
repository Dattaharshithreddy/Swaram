"""Joins the narration sentences into one file per reel line (audio/l01.wav .. l13.wav) and uploads them, with the
sentence wavs, to the private HF bucket the render reads from. The voice never goes into this public repo."""
import glob, json, os, re, sys
import numpy as np, soundfile as sf
from huggingface_hub import HfApi
parts = json.load(open('scripts/tirumala_parts.json', encoding='utf-8'))
wav = {int(re.findall(r'\d+', os.path.basename(f))[-1]): f for f in glob.glob('render-out/narr/**/*.wav', recursive=True)}
missing = [p['i'] for p in parts if p['i'] not in wav]
if missing: sys.exit(f'missing sentences {missing}')
os.makedirs('render-out/lines', exist_ok=True)
SR = 24000; gap = np.zeros(int(0.30 * SR), np.float32); tail = np.zeros(int(0.35 * SR), np.float32)
for para in sorted({p['para'] for p in parts}):
    chunks = []
    for p in [p for p in parts if p['para'] == para]:
        a, sr = sf.read(wav[p['i']], dtype='float32'); assert sr == SR, sr
        if a.ndim > 1: a = a.mean(1)
        chunks += [a, gap]
    out = np.concatenate(chunks[:-1] + [tail])
    sf.write(f'render-out/lines/l{para + 1:02d}.wav', out, SR, subtype='PCM_16')
    print(f'l{para + 1:02d}', round(len(out) / SR, 2), 's')
api = HfApi(token=os.environ['HF_TOKEN'])
api.sync_bucket('render-out/lines', 'hf://buckets/HarshithReddy05/tirumala-reel/audio', quiet=True)
print('uploaded', len(os.listdir('render-out/lines')), 'line files')
