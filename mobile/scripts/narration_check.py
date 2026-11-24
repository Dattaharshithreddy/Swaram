"""Transcribes a reel's narration lines (private HF bucket) with Whisper and prints only the text, so the narration
can be checked against the script without the voice leaving the bucket."""
import json, os, sys, tempfile
import numpy as np, soundfile as sf
from scipy.signal import resample_poly
from huggingface_hub import HfApi
from faster_whisper import WhisperModel
cfg = json.load(open('render/narration_check.json'))
api = HfApi(token=os.environ['HF_TOKEN']); d = tempfile.mkdtemp()
api.sync_bucket(cfg['src'], d, quiet=True)
files = sorted(f for f in os.listdir(d) if f.endswith('.wav'))
m = WhisperModel(cfg.get('model', 'medium'), device='cpu', compute_type='int8')
for f in files:
    a, sr = sf.read(os.path.join(d, f), dtype='float32'); a = a.mean(1) if a.ndim > 1 else a; a = resample_poly(a, 16000, sr).astype(np.float32)
    segs, info = m.transcribe(a, language='te', beam_size=5)
    segs = list(segs); end = segs[-1].end if segs else 0
    print(f'{f} ({info.duration:.2f}s, speech ends {end:.2f}s): ' + ' '.join(s.text.strip() for s in segs), flush=True)
