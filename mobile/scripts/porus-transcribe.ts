/**
 * Transcribe the owner's finished Puru narration on a Kaggle GPU, to check it against the script.
 * The audio sits encrypted on the porus-src branch; its key is in the owner's private Hugging Face
 * dataset, read on Kaggle with HF_TOKEN. Only the transcript (the reel's public script text) is printed.
 *   node --experimental-strip-types scripts/porus-transcribe.ts
 */
import { pushNotebook, runOutputs, runStatus } from '../src/edge/kaggle.ts';

const auth = { username: process.env.KAGGLE_USERNAME ?? '', token: process.env.KAGGLE_API_TOKEN ?? '' };
const hf = process.env.HF_TOKEN ?? '';
if (!auth.username || !auth.token || !hf) throw new Error('secrets missing');
const src = `import os, json, subprocess, urllib.request, torch
from huggingface_hub import hf_hub_download
HF = ${JSON.stringify(hf)}
key = open(hf_hub_download('HarshithReddy05/porus-private', 'key.txt', repo_type='dataset', token=HF)).read().strip()
urllib.request.urlretrieve('https://raw.githubusercontent.com/Dattaharshithreddy/Swaram/porus-src/up.opus.enc', '/tmp/a.enc')
subprocess.run(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-in', '/tmp/a.enc', '-out', '/tmp/a.opus', '-pass', 'pass:' + key], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', '/tmp/a.opus', '-ar', '16000', '-ac', '1', '/tmp/a.wav'], check=True)
from transformers import pipeline
for model in ['vasista22/whisper-telugu-large-v2', 'openai/whisper-large-v3']:
    try:
        p = pipeline('automatic-speech-recognition', model=model, torch_dtype=torch.float16, device=0, token=HF)
        try: r = p('/tmp/a.wav', chunk_length_s=30, batch_size=4, return_timestamps=True, generate_kwargs={'language': 'telugu', 'task': 'transcribe'})
        except Exception: r = p('/tmp/a.wav', chunk_length_s=30, batch_size=4, return_timestamps=True)
        print('###' + model + '###' + json.dumps([[c['timestamp'][0], c['timestamp'][1], c['text']] for c in r['chunks']], ensure_ascii=False))
        del p; torch.cuda.empty_cache()
    except Exception as e:
        print('###' + model + '###FAILED ' + repr(e)[:300])
for f in ('/tmp/a.enc', '/tmp/a.opus', '/tmp/a.wav'): os.remove(f)
`;
const nb = { metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } }, nbformat: 4, nbformat_minor: 4,
  cells: [{ cell_type: 'code', metadata: {}, outputs: [], execution_count: null, source: src }] };
const slug = 'swaram-porus-transcribe';
await pushNotebook(auth, slug, nb, { gpu: true, internet: true, timeoutSeconds: 3600 });
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
