/**
 * End-to-end check of studio rendering on a real Kaggle GPU: pushes
 * cloud/swaram_render.ipynb with two short Telugu lines (the same cell the app
 * adds), waits for it, downloads swaram-render.zip and checks both lines are in it.
 * Needs KAGGLE_USERNAME, KAGGLE_API_TOKEN and HF_TOKEN.
 *   node --experimental-strip-types scripts/kaggle-render-test.ts
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { bytesToBase64, pushNotebook, runOutputs, runStatus } from '../src/edge/kaggle.ts';

const auth = { username: process.env.KAGGLE_USERNAME ?? '', token: process.env.KAGGLE_API_TOKEN ?? '' };
const hf = process.env.HF_TOKEN ?? '';
if (!auth.username || !auth.token || !hf) {
  console.log('KAGGLE_USERNAME / KAGGLE_API_TOKEN / HF_TOKEN not set; skipping');
  process.exit(0);
}
const wav = new Uint8Array(await (await fetch('https://raw.githubusercontent.com/AI4Bharat/IndicF5/main/prompts/PAN_F_HAPPY_00001.wav')).arrayBuffer());
const nb = JSON.parse(readFileSync('../cloud/swaram_render.ipynb', 'utf-8'));
const appRender = {
  steps: 32,
  cfg: 2.0,
  voices: {
    'f5:test': {
      text: 'ਭਹੰਪੀ ਵਿੱਚ ਸਮਾਰਕਾਂ ਦੇ ਭਵਨ ਨਿਰਮਾਣ ਕਲਾ ਦੇ ਵੇਰਵੇ ਗੁੰਝਲਦਾਰ ਅਤੇ ਹੈਰਾਨ ਕਰਨ ਵਾਲੇ ਹਨ, ਜੋ ਮੈਨੂੰ ਖੁਸ਼ ਕਰਦੇ  ਹਨ।',
      wav_base64: bytesToBase64(wav),
    },
  },
  parts: [
    { i: 0, voice: 'f5:test', text: 'స్పేస్ లో శాటిలైట్స్ అలా ఎలా తిరుగుతూ ఉంటాయి? అక్కడ గ్రావిటీ ఉండదు కదా.', speed: 1 },
    { i: 2, voice: 'f5:test', text: 'అది ఎగరట్లేదు, ఎప్పటికీ పడిపోతూనే ఉంది! మైండ్ బ్లోయింగ్ కదా?', speed: 1 },
  ],
};
nb.cells.splice(1, 0, {
  cell_type: 'code',
  metadata: {},
  outputs: [],
  execution_count: null,
  source: `import os\nos.environ["HF_TOKEN"] = ${JSON.stringify(hf)}\nAPP_RENDER = ${JSON.stringify(appRender)}`,
});
const slug = 'swaram-render-check';
const t0 = Date.now();
const pushed = await pushNotebook(auth, slug, nb, { gpu: true, internet: true, timeoutSeconds: 3600 });
console.log('pushed', JSON.stringify(pushed));
let state = '';
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 20000));
  const s = await runStatus(auth, slug);
  if (i % 3 === 0) console.log(`${Math.round((Date.now() - t0) / 60000)} min`, s.state, s.message ?? '');
  state = s.state;
  if (s.state === 'complete' || s.state === 'error' || s.state === 'cancelled') break;
}
const out = await runOutputs(auth, slug).catch((e) => ({ files: [], log: String(e) }));
if (state !== 'complete') {
  console.log('log:', (out.log ?? '').slice(-4000));
  throw new Error(`run ended as ${state}`);
}
const zip = out.files.find((f) => f.fileName.endsWith('swaram-render.zip'));
if (!zip) throw new Error(`no swaram-render.zip in ${out.files.map((f) => f.fileName).join(', ')}`);
mkdirSync('render-out', { recursive: true });
writeFileSync('render-out/r.zip', new Uint8Array(await (await fetch(zip.url)).arrayBuffer()));
execSync('cd render-out && unzip -o r.zip');
for (const n of ['part-00000.wav', 'part-00002.wav']) {
  const size = statSync(`render-out/${n}`).size;
  console.log(n, size, 'bytes', ((size - 44) / 2 / 24000).toFixed(1), 's');
  if (size < 24000) throw new Error(`${n} is too short`);
}
console.log(`Studio render check passed in ${Math.round((Date.now() - t0) / 60000)} min`);
