/**
 * Lists the Swaram notebooks on the Kaggle account (trainings and renders) with
 * their run state and output files. Read-only.
 *   node --experimental-strip-types scripts/kaggle-status.ts
 */
import { runOutputs, runStatus } from '../src/edge/kaggle.ts';

const auth = { username: process.env.KAGGLE_USERNAME ?? '', token: process.env.KAGGLE_API_TOKEN ?? '' };
if (!auth.username || !auth.token) {
  console.log('KAGGLE_USERNAME / KAGGLE_API_TOKEN not set');
  process.exit(0);
}
const token = auth.token.trim();
const authHeader = /^[0-9a-f]{32}$/i.test(token) ? `Basic ${btoa(`${auth.username}:${token}`)}` : `Bearer ${token}`;
const res = await fetch('https://api.kaggle.com/v1/kernels.KernelsApiService/ListKernels', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: authHeader },
  body: JSON.stringify({ user: auth.username, search: 'swaram', group: 'PROFILE', sortBy: 'DATE_RUN', pageSize: 50 }),
});
const data = (await res.json()) as { kernels?: { ref?: string; title?: string; lastRunTime?: string }[] };
for (const k of data.kernels ?? []) {
  const slug = (k.ref ?? '').split('/')[1];
  if (!slug || /check/.test(slug)) continue;
  const s = await runStatus(auth, slug).catch((e) => ({ state: `? ${e}` }));
  let files = '';
  if (s.state === 'complete') {
    const out = await runOutputs(auth, slug).catch(() => ({ files: [] as { fileName: string }[] }));
    files = out.files.map((f) => f.fileName).filter((n) => /zip|safetensors|json|wav/.test(n)).slice(0, 6).join(', ');
  }
  console.log(`${slug} | last run ${k.lastRunTime ?? '?'} | ${s.state}${files ? ` | ${files}` : ''}`);
}
