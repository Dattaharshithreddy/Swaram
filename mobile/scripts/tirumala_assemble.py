"""Joins the narration sentences into one file per reel line (audio/l01.wav .. l13.wav) and uploads them, with the
sentence wavs, to the private HF bucket the render reads from. The voice never goes into this public repo."""
import glob, json, os, re, sys
import numpy as np, soundfile as sf
from huggingface_hub import HfApi
parts = json.load(open(f"scripts/{os.environ.get('REEL', 'tirumala')}_parts.json", encoding='utf-8'))
wav = {int(re.findall(r'\d+', os.path.basename(f))[-1]): f for f in glob.glob('render-out/narr/**/*.wav', recursive=True)}
missing = [p['i'] for p in parts if p['i'] not in wav]
if missing: sys.exit(f'missing sentences {missing}')
os.makedirs('render-out/lines', exist_ok=True)
SR = 24000; gap = np.zeros(int(float(os.environ.get('GAP', 0.30)) * SR), np.float32); tail = np.zeros(int(float(os.environ.get('TAIL', 0.35)) * SR), np.float32)
MAXP = float(os.environ.get('MAX_PAUSE', 0))   # >0: any pause inside a sentence longer than this is shortened to it
def squeeze(a):
    if MAXP <= 0: return a
    w = int(0.02 * SR); n = len(a) // w; e = np.array([np.sqrt(np.mean(a[i * w:(i + 1) * w] ** 2)) for i in range(n)])
    quiet = e < max(1e-4, 10 ** (-40 / 20) * e.max()); out, i, f = [], 0, int(0.012 * SR); ramp = np.linspace(1, 0, f, dtype=np.float32)
    lead = next((k for k in range(n) if not quiet[k]), 0); trail = next((k for k in range(n - 1, -1, -1) if not quiet[k]), n - 1)
    k = lead; seg_start = lead * w
    while k <= trail:
        if quiet[k]:
            j = k
            while j <= trail and quiet[j]: j += 1
            if (j - k) * w > MAXP * SR:
                keep = int(MAXP * SR) // 2; a1 = a[seg_start:k * w + keep].copy(); a1[-f:] *= ramp; out.append(a1)
                seg_start = j * w - keep; nxt = a[seg_start:]; nxt[:f] *= ramp[::-1]
            k = j
        else: k += 1
    out.append(a[seg_start:(trail + 1) * w]); return np.concatenate(out)
for para in sorted({p['para'] for p in parts}):
    chunks = []
    for p in [p for p in parts if p['para'] == para]:
        a, sr = sf.read(wav[p['i']], dtype='float32'); assert sr == SR, sr
        if a.ndim > 1: a = a.mean(1)
        a = squeeze(a); chunks += [a, gap]
    out = np.concatenate(chunks[:-1] + [tail])
    sf.write(f'render-out/lines/l{para + 1:02d}.wav', out, SR, subtype='PCM_16')
    print(f'l{para + 1:02d}', round(len(out) / SR, 2), 's')
api = HfApi(token=os.environ['HF_TOKEN'])
api.sync_bucket('render-out/lines', os.environ.get('AUDIO_DEST', 'hf://buckets/HarshithReddy05/tirumala-reel/audio'), quiet=True)
print('uploaded', len(os.listdir('render-out/lines')), 'line files')
