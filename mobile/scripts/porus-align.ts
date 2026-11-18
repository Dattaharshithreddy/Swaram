/**
 * Align the script to the owner's finished Puru narration (MMS forced alignment) on a Kaggle GPU, to check it against the script.
 * The audio sits encrypted on the porus-src branch; its key is in the owner's private Hugging Face
 * dataset, read on Kaggle with HF_TOKEN. Only the transcript (the reel's public script text) is printed.
 *   node --experimental-strip-types scripts/porus-transcribe.ts
 */
import { readFileSync } from 'node:fs';
import { pushNotebook, runOutputs, runStatus } from '../src/edge/kaggle.ts';

const auth = { username: process.env.KAGGLE_USERNAME ?? '', token: process.env.KAGGLE_API_TOKEN ?? '' };
const hf = process.env.HF_TOKEN ?? '';
if (!auth.username || !auth.token || !hf) throw new Error('secrets missing');
const SENTS = (JSON.parse(readFileSync('scripts/porus_parts.json', 'utf-8')) as { text: string }[]).map((p) => p.text);
const src = `import os, json, subprocess, urllib.request, torch
from huggingface_hub import hf_hub_download
HF = ${JSON.stringify(hf)}
key = open(hf_hub_download('HarshithReddy05/porus-private', 'key.txt', repo_type='dataset', token=HF)).read().strip()
urllib.request.urlretrieve('https://raw.githubusercontent.com/Dattaharshithreddy/Swaram/porus-src/up.opus.enc', '/tmp/a.enc')
subprocess.run(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-in', '/tmp/a.enc', '-out', '/tmp/a.opus', '-pass', 'pass:' + key], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', '/tmp/a.opus', '-ar', '16000', '-ac', '1', '/tmp/a.wav'], check=True)
import re, sys
subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'uroman'], check=True)
import uroman as _ur, torchaudio
SENTS = ${JSON.stringify(SENTS)}
ro = _ur.Uroman()
def rom(w): return re.sub(r"[^a-z']", '', ro.romanize_string(w).lower())
words, owner = [], []
for i, t in enumerate(SENTS):
    for w in t.split():
        r = rom(w)
        if r: words.append(r); owner.append(i)
b = torchaudio.pipelines.MMS_FA
model = b.get_model(with_star=False).cuda(); tok = b.get_tokenizer(); al = b.get_aligner()
wav, sr = torchaudio.load('/tmp/a.wav')
with torch.inference_mode():
    em, _ = model(wav.cuda())
spans = al(em[0], tok(words))
ratio = wav.size(1) / em.size(1) / sr
res = {}
for (sp, i) in zip(spans, owner):
    a, z = sp[0].start * ratio, sp[-1].end * ratio
    r = res.setdefault(i, [a, z]); r[0] = min(r[0], a); r[1] = max(r[1], z)
print('###ALIGN###' + json.dumps([[i, round(res[i][0], 3), round(res[i][1], 3)] for i in sorted(res)]))
for f in ('/tmp/a.enc', '/tmp/a.opus', '/tmp/a.wav'): os.remove(f)
`;
const nb = { metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } }, nbformat: 4, nbformat_minor: 4,
  cells: [{ cell_type: 'code', metadata: {}, outputs: [], execution_count: null, source: src }] };
const slug = 'swaram-porus-align';
await pushNotebook(auth, slug, nb, { gpu: true, internet: true, timeoutSeconds: 2400 });
let state = '';
for (let i = 0; i < 150; i++) {
  await new Promise((r) => setTimeout(r, 20000));
  const s = await runStatus(auth, slug); state = s.state;
  if (i % 3 === 0) console.log(`${i / 3} min`, s.state);
  if (['complete', 'error', 'cancelled'].includes(s.state)) break;
}
const out = await runOutputs(auth, slug);
const lines = (out.log ?? '').split('\n').map((l) => { try { return (JSON.parse(l.replace(/^,/, '')) as { data: string }).data; } catch { return ''; } }).join('').split('\n');
const hits = lines.filter((l) => l.startsWith('###'));
for (const h of hits) console.log('TRANSCRIPT' + h);
if (!hits.length) { console.log(lines.filter((l) => !/it\/s|%\|/.test(l)).slice(-40).join('\n')); throw new Error('transcription ended as ' + state); }
