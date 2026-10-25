/**
 * Runs the fast-voice training notebook (personal-voice/swaram_personal_voice.ipynb)
 * on a real Kaggle GPU with a tiny setting (24 sentences, ~5 minutes of training),
 * the way the app starts it, and checks a voice pack comes out.
 * Needs KAGGLE_USERNAME, KAGGLE_API_TOKEN and HF_TOKEN.
 */
import { readFileSync } from 'node:fs';
import { bytesToBase64, pushNotebook, runOutputs, runStatus, trainingNotebook } from '../src/edge/kaggle.ts';

const auth = { username: process.env.KAGGLE_USERNAME ?? '', token: process.env.KAGGLE_API_TOKEN ?? '' };
const hf = process.env.HF_TOKEN ?? '';
if (!auth.username || !auth.token || !hf) {
  console.log('KAGGLE_USERNAME / KAGGLE_API_TOKEN / HF_TOKEN not set; skipping');
  process.exit(0);
}
const wav = new Uint8Array(await (await fetch('https://raw.githubusercontent.com/AI4Bharat/IndicF5/main/prompts/PAN_F_HAPPY_00001.wav')).arrayBuffer());
const template = JSON.parse(readFileSync('../personal-voice/swaram_personal_voice.ipynb', 'utf-8'));
for (const cell of template.cells) {
  const src = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
  cell.source = src.replace('SENTENCES = None', 'SENTENCES = 24').replace('TRAIN_HOURS = None', 'TRAIN_HOURS = 0.08');
}
const nb = trainingNotebook(
  template,
  {
    name: 'Check',
    language: 'te',
    text: 'ਭਹੰਪੀ ਵਿੱਚ ਸਮਾਰਕਾਂ ਦੇ ਭਵਨ ਨਿਰਮਾਣ ਕਲਾ ਦੇ ਵੇਰਵੇ ਗੁੰਝਲਦਾਰ ਅਤੇ ਹੈਰਾਨ ਕਰਨ ਵਾਲੇ ਹਨ, ਜੋ ਮੈਨੂੰ ਖੁਸ਼ ਕਰਦੇ  ਹਨ।',
    wavBase64: bytesToBase64(wav),
  },
  hf,
  'quick',
);
const slug = 'swaram-voice-check';
const t0 = Date.now();
await pushNotebook(auth, slug, nb, { gpu: true, internet: true, timeoutSeconds: 3 * 3600 });
let state = '';
for (let i = 0; i < 400; i++) {
  await new Promise((r) => setTimeout(r, 20000));
  const s = await runStatus(auth, slug);
  if (i % 6 === 0) console.log(`${Math.round((Date.now() - t0) / 60000)} min`, s.state, s.message ?? '');
  state = s.state;
  if (s.state === 'complete' || s.state === 'error' || s.state === 'cancelled') break;
}
const out = await runOutputs(auth, slug).catch((e) => ({ files: [] as { url: string; fileName: string }[], log: String(e) }));
const lines = (out.log ?? '').split('\n').map((l) => { try { return (JSON.parse(l.replace(/^,/, '')) as { data: string }).data.trimEnd(); } catch { return ''; } }).filter(Boolean);
console.log(lines.filter((l) => /done, |clips, |precision|Error|silent|Mode:|Training data/.test(l)).slice(-20).join('\n'));
if (state !== 'complete') throw new Error(`run ended as ${state}`);
const pack = out.files.find((f) => /swaram-voice-.*\.zip$/.test(f.fileName));
if (!pack) throw new Error(`no voice pack in ${out.files.map((f) => f.fileName).join(', ')}`);
console.log(`Fast voice check passed in ${Math.round((Date.now() - t0) / 60000)} min: ${pack.fileName}`);
