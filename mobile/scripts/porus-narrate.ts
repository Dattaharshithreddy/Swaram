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

// 1. the trained studio voice: reference clip + transcript + weights name
const tr = await runOutputs(auth, TRAIN);
const get = async (n: string) => {
  const f = tr.files.find((x) => x.fileName.endsWith(n));
  if (!f) throw new Error(`${n} not in ${TRAIN} outputs: ${tr.files.map((x) => x.fileName).join(', ')}`);
  return new Uint8Array(await (await fetch(f.url)).arrayBuffer());
};
const meta = JSON.parse(new TextDecoder().decode(await get('studio-voice.json')));
console.log('studio voice fields:', Object.keys(meta).join(', '));
const ckpt = tr.files.map((f) => f.fileName.split('/').pop()!).find((n) => n.endsWith('.safetensors'))!;
const refText: string = meta.text ?? meta.ref_text ?? meta.reference_text ?? meta.sample_text ?? meta.transcript ?? '';
let refWav = await get('sample.wav');
if (meta.ref_wav_base64) refWav = Uint8Array.from(atob(meta.ref_wav_base64), (c) => c.charCodeAt(0));
console.log('weights', ckpt, '| reference text', refText ? `${refText.length} chars` : 'MISSING', '| reference', refWav.length, 'bytes');
if (!refText) throw new Error('no reference transcript in studio-voice.json');

// 2. the script
let parts = JSON.parse(readFileSync('scripts/porus_parts.json', 'utf-8')) as { i: number; para: number; mood: string; text: string; speed: number }[];
if (ONLY.length) parts = parts.filter((p) => ONLY.includes(p.i));
const job = {
  steps: Number(process.env.STEPS ?? 40), cfg: 2.0,
  voices: { datta: { text: refText, wav_base64: bytesToBase64(refWav), ckpt_name: ckpt } },
  parts: parts.map((p) => ({ i: p.i, voice: 'datta', text: p.text, speed: p.speed })),
};
const nb = JSON.parse(readFileSync('../cloud/swaram_render.ipynb', 'utf-8'));
nb.cells.splice(1, 0, { cell_type: 'code', metadata: {}, outputs: [], execution_count: null,
  source: `import os\nos.environ["HF_TOKEN"] = ${JSON.stringify(hf)}\nAPP_RENDER = ${JSON.stringify(job)}` });

// 3. run it
const slug = 'swaram-porus-narration';
const t0 = Date.now();
const pushed = await pushNotebook(auth, slug, nb, { gpu: true, internet: true, timeoutSeconds: 5400, kernelSources: [TRAIN] });
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
