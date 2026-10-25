/**
 * End-to-end check of studio rendering on a real Kaggle GPU: pushes
 * cloud/swaram_render.ipynb with two short Telugu lines (the same cell the app
 * adds), waits for it, downloads swaram-render.zip and checks both lines are in it.
 * Needs KAGGLE_USERNAME, KAGGLE_API_TOKEN and HF_TOKEN.
 *   node --experimental-strip-types scripts/kaggle-render-test.ts
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { bytesToBase64, createPrivateDataset, datasetStatus, pushNotebook, runOutputs, runStatus } from '../src/edge/kaggle.ts';

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
const t0 = Date.now();
async function run(slug: string, notebook: object, extra: { kernelSources?: string[]; datasetSources?: string[] } = {}) {
  const pushed = await pushNotebook(auth, slug, notebook as never, { gpu: true, internet: true, timeoutSeconds: 3600, ...extra });
  console.log('pushed', slug, pushed.url ?? '');
  let state = '';
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 20000));
    const s = await runStatus(auth, slug);
    if (i % 3 === 0) console.log(`${Math.round((Date.now() - t0) / 60000)} min`, slug, s.state, s.message ?? '');
    state = s.state;
    if (s.state === 'complete' || s.state === 'error' || s.state === 'cancelled') break;
  }
  const out = await runOutputs(auth, slug).catch((e) => ({ files: [] as { url: string; fileName: string }[], log: String(e) }));
  if (state !== 'complete') {
    const log = out.log ?? '';
    const lines = log.split('\n').filter((l) => /Error|Traceback|error:|No module|assert/i.test(l) && !/NbConvert/.test(l));
    console.log('errors:', lines.slice(-25).join('\n'));
    console.log('log tail:', log.slice(-2500));
    throw new Error(`${slug} ended as ${state}`);
  }
  return out;
}
const slug = 'swaram-render-check';
const out = await run(slug, nb);
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

// Studio voice: upload recordings as a private dataset, train for a few minutes, render with the result.
mkdirSync('render-out/pack/clips', { recursive: true });
execSync('cp render-out/part-00000.wav render-out/pack/clips/0000.wav && cp render-out/part-00002.wav render-out/pack/clips/0001.wav');
writeFileSync('render-out/pack/metadata.csv', `0000.wav|${appRender.parts[0].text}\n0001.wav|${appRender.parts[1].text}`);
const stamp = Date.now().toString(36);
execSync(`cd render-out/pack && zip -q -r ../swaram-pro-${stamp}.zip clips metadata.csv`);
const zipPath = `render-out/swaram-pro-${stamp}.zip`;
const zipBytes = readFileSync(zipPath);
const dataSlug = `swaram-pro-check-${stamp}`;
await createPrivateDataset(auth, dataSlug, `Swaram check ${stamp}`, { name: `swaram-pro-${stamp}.zip`, bytes: zipBytes.length, contentType: 'application/zip' }, async (url) => {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/zip' }, body: zipBytes });
  if (!res.ok) throw new Error(`upload HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
});
for (let i = 0; i < 60; i++) {
  const st = await datasetStatus(auth, dataSlug).catch((e) => String(e));
  console.log('dataset', st);
  if (st.includes('ready') || st.includes('complete')) break;
  await new Promise((r) => setTimeout(r, 10000));
}
const pro = JSON.parse(readFileSync('../cloud/swaram_pro_voice.ipynb', 'utf-8'));
pro.cells.splice(1, 0, {
  cell_type: 'code', metadata: {}, outputs: [], execution_count: null,
  source: `import os\nos.environ["HF_TOKEN"] = ${JSON.stringify(hf)}\nAPP_PRO = ${JSON.stringify({ id: 'check', name: 'Check', hours: 0.05 })}`,
});
const proSlug = 'swaram-studio-voice-check';
const proOut = await run(proSlug, pro, { datasetSources: [dataSlug] });
if (!proOut.files.some((f) => f.fileName.endsWith('voice-model-check.safetensors'))) throw new Error(`no trained voice in ${proOut.files.map((f) => f.fileName).join(', ')}`);
console.log('studio voice trained');

const nb2 = JSON.parse(readFileSync('../cloud/swaram_render.ipynb', 'utf-8'));
const withVoice = { ...appRender, voices: { 'f5:test': { ...appRender.voices['f5:test'], ckpt_name: 'voice-model-check.safetensors' } }, parts: [appRender.parts[0]] };
nb2.cells.splice(1, 0, {
  cell_type: 'code', metadata: {}, outputs: [], execution_count: null,
  source: `import os\nos.environ["HF_TOKEN"] = ${JSON.stringify(hf)}\nAPP_RENDER = ${JSON.stringify(withVoice)}`,
});
const out2 = await run('swaram-render-check-voice', nb2, { kernelSources: [proSlug] });
if (!(out2.log ?? '').includes('Trained model not found') && out2.files.some((f) => f.fileName.endsWith('swaram-render.zip'))) {
  console.log(`Studio voice render check passed in ${Math.round((Date.now() - t0) / 60000)} min`);
} else {
  throw new Error('render with the studio voice did not use it');
}
