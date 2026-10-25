/**
 * Checks src/edge/kaggle.ts against the real Kaggle API: pushes a tiny CPU
 * notebook that writes an output file, waits for it, lists and downloads the
 * output. Needs KAGGLE_USERNAME and KAGGLE_API_TOKEN.
 *   node --experimental-strip-types scripts/kaggle-api-test.ts
 */
import { pushNotebook, runOutputs, runStatus } from '../src/edge/kaggle.ts';

const auth = { username: process.env.KAGGLE_USERNAME ?? '', token: process.env.KAGGLE_API_TOKEN ?? '' };
if (!auth.username || !auth.token) {
  console.log('KAGGLE_USERNAME / KAGGLE_API_TOKEN not set; skipping');
  process.exit(0);
}
const slug = 'swaram-api-check';
const notebook = {
  cells: [
    {
      cell_type: 'code',
      source: 'import os\nos.makedirs("/kaggle/working/output", exist_ok=True)\nopen("/kaggle/working/output/hello.txt", "w").write("swaram ok")\nprint("done")',
    },
  ],
};
const pushed = await pushNotebook(auth, slug, notebook, { gpu: false, internet: false });
console.log('pushed', JSON.stringify(pushed));
let state = '';
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const s = await runStatus(auth, slug);
  console.log('status', s.state, s.raw, s.message ?? '');
  state = s.state;
  if (s.state === 'complete' || s.state === 'error' || s.state === 'cancelled') break;
}
if (state !== 'complete') throw new Error(`run ended as ${state}`);
const out = await runOutputs(auth, slug);
console.log('files', out.files.map((f) => f.fileName).join(', '));
const hello = out.files.find((f) => f.fileName.endsWith('hello.txt'));
if (!hello) throw new Error('hello.txt not in outputs');
const text = await (await fetch(hello.url)).text();
if (text.trim() !== 'swaram ok') throw new Error(`unexpected content: ${text.slice(0, 100)}`);
console.log('Kaggle API check passed');
