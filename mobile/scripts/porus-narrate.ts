/**
 * Puru reel narration on a Kaggle GPU with the owner's trained studio voice (no server needed).
 * One part per sentence so the voice never drifts over a long take; speed per mood.
 * Reference voice and weights come from the finished studio-voice training run.
 * Output: render-out/porus-narr.zip (one wav per sentence + parts.json), encrypted by the workflow.
 *   node --experimental-strip-types scripts/porus-narrate.ts
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { bytesToBase64, pushNotebook, runOutputs, runStatus } from '../src/edge/kaggle.ts';

const auth = { username: process.env.KAGGLE_USERNAME ?? '', token: process.env.KAGGLE_API_TOKEN ?? '' };
const hf = process.env.HF_TOKEN ?? '';
const TRAIN = process.env.STUDIO_RUN ?? 'swaram-studio-voice-retrain1';
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean).map(Number);   // re-render chosen sentences only
if (!auth.username || !auth.token) throw new Error('Kaggle secrets missing');
mkdirSync('render-out', { recursive: true });

// 1. the trained studio voice: weights from the training run, reference = one of the owner's own recordings
const tr = await runOutputs(auth, TRAIN);
const ckpt = tr.files.map((f) => f.fileName.split('/').pop()!).find((n) => n.endsWith('.safetensors'))!;
const tok = auth.token.trim();
const authHeader = /^[0-9a-f]{32}$/i.test(tok) ? `Basic ${btoa(`${auth.username.trim()}:${tok}`)}` : `Bearer ${tok}`;
const k = await (await fetch('https://api.kaggle.com/v1/kernels.KernelsApiService/GetKernel', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authHeader },
  body: JSON.stringify({ userName: auth.username.trim(), kernelSlug: TRAIN }) })).json() as Record<string, any>;
const meta = k.metadata ?? k;
let datasets: string[] = (meta.datasetDataSources ?? meta.dataset_data_sources ?? []) as string[];
if (!datasets.length) {
  const l = await (await fetch('https://api.kaggle.com/v1/datasets.DatasetApiService/ListDatasets', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authHeader },
    body: JSON.stringify({ user: auth.username.trim(), search: 'swaram-pro', page: 1 }) })).json() as Record<string, any>;
  datasets = ((l.datasets ?? []) as { ref?: string }[]).map((d) => d.ref ?? '').filter((r) => r && !r.includes('check'));
}
console.log('weights', ckpt, '| recordings', datasets.join(', ') || 'NONE');
if (!datasets.length) throw new Error('recordings dataset not found');
const refWav = new Uint8Array(0); const refText = '';
// 2. the script
let parts = JSON.parse(readFileSync('scripts/porus_parts.json', 'utf-8')) as { i: number; para: number; mood: string; text: string; speed: number }[];
if (ONLY.length) parts = parts.filter((p) => ONLY.includes(p.i));
const job = {
  steps: Number(process.env.STEPS ?? 40), cfg: 2.0,
  voices: { datta: { text: refText, wav_base64: bytesToBase64(refWav), ckpt_name: ckpt } },   // reference filled in on Kaggle
  parts: parts.map((p) => ({ i: p.i, voice: 'datta', text: p.text, speed: p.speed })),
};
const nb = JSON.parse(readFileSync('../cloud/swaram_render.ipynb', 'utf-8'));
nb.cells.splice(1, 0, { cell_type: 'code', metadata: {}, outputs: [], execution_count: null,
  source: `import os, glob, base64, soundfile as _sf, librosa as _lr\nos.environ["HF_TOKEN"] = ${JSON.stringify(hf)}\nAPP_RENDER = ${JSON.stringify(job)}\n` +
`_m = glob.glob('/kaggle/input/**/metadata.csv', recursive=True)\nassert _m, glob.glob('/kaggle/input/**', recursive=True)[:40]\n` +
`_rows = [l.split('|', 1) for l in open(_m[0], encoding='utf-8').read().splitlines() if '|' in l]\n_best = None\n` +
`for _n, _t in _rows:\n    _f = glob.glob(os.path.dirname(_m[0]) + '/**/' + _n, recursive=True)\n    if not _f: continue\n` +
`    _d = _lr.get_duration(path=_f[0])\n    _sc = abs(_d - 8.5) + (0 if _t.strip().endswith(('.', '?', '!')) else 1)\n` +
`    if 5.5 <= _d <= 11.5 and (_best is None or _sc < _best[0]): _best = (_sc, _f[0], _t.strip(), _d)\n` +
`assert _best, 'no usable recording'\nprint('reference', os.path.basename(_best[1]), round(_best[3], 1), 's')\n` +
`_w, _ = _lr.load(_best[1], sr=24000, mono=True); _sf.write('/kaggle/working/ref.wav', _w, 24000)\n` +
`APP_RENDER['voices']['datta']['wav_base64'] = base64.b64encode(open('/kaggle/working/ref.wav', 'rb').read()).decode()\nAPP_RENDER['voices']['datta']['text'] = _best[2]` });

// 3. run it
const slug = 'swaram-porus-narration';
const t0 = Date.now();
const pushed = await pushNotebook(auth, slug, nb, { gpu: true, internet: true, timeoutSeconds: 5400, kernelSources: [TRAIN], datasetSources: datasets });
console.log('pushed', pushed.url ?? slug, parts.length, 'sentences');
let state = '';
for (let i = 0; i < 260; i++) {
  await new Promise((r) => setTimeout(r, 20000));
  const s = await runStatus(auth, slug); state = s.state;
  if (i % 3 === 0) console.log(`${Math.round((Date.now() - t0) / 60000)} min`, s.state, s.message ?? '');
  if (['complete', 'error', 'cancelled'].includes(s.state)) break;
}
const out = await runOutputs(auth, slug);
if (state !== 'complete') {
  console.log((out.log ?? '').slice(-3000));
  throw new Error(`narration run ended as ${state}`);
}
if ((out.log ?? '').includes('Trained model not found')) console.log('WARNING: studio weights not found, used the normal model');
const zip = out.files.find((f) => f.fileName.endsWith('swaram-render.zip'));
if (!zip) throw new Error(`no swaram-render.zip in ${out.files.map((f) => f.fileName).join(', ')}`);
writeFileSync('render-out/r.zip', new Uint8Array(await (await fetch(zip.url)).arrayBuffer()));
execSync('cd render-out && mkdir -p narr && unzip -o -q r.zip -d narr && rm r.zip');
writeFileSync('render-out/narr/parts.json', JSON.stringify(parts, null, 0));
const wavs = readdirSync('render-out/narr').filter((n) => n.endsWith('.wav'));
console.log(wavs.length, 'sentence files');
execSync('cd render-out && zip -q -r porus-narr.zip narr');
console.log(`narration done in ${Math.round((Date.now() - t0) / 60000)} min`);
