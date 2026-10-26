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
  if (!slug || (/check/.test(slug) && slug !== 'swaram-voice-check')) continue;
  const s = await runStatus(auth, slug).catch((e) => ({ state: `? ${e}` }));
  let files = '';
  if (s.state === 'error') {
    const out = await runOutputs(auth, slug).catch((e) => ({ files: [], log: String(e) }));
    const lines = (out.log ?? '').split('\n').filter((l) => /Error|Traceback|error:|No module|assert|Killed|CUDA|exit status/i.test(l) && !/NbConvert|Warning/.test(l));
    files = `errors: ${lines.slice(-12).join(' // ').slice(0, 1500)}`;
    const all = (out.log ?? '').split('\n').map((l) => { try { return (JSON.parse(l.replace(/^,/, '')) as { data: string }).data.trimEnd(); } catch { return ''; } }).filter(Boolean);
    const at = all.findIndex((l) => l.includes('IndexError') || l.includes('Error:'));
    if (at >= 0) console.log(`--- ${slug} context ---\n${all.slice(Math.max(0, at - 45), at + 3).join('\n')}`);
  }
  if (slug === 'swaram-voice-check' && s.state !== 'running') {
    const o = await runOutputs(auth, slug).catch(() => ({ files: [], log: '' }));
    const ls = (o.log ?? '').split('\n').map((l) => { try { return (JSON.parse(l.replace(/^,/, '')) as { data: string }).data.trimEnd(); } catch { return ''; } }).filter(Boolean);
    console.log(`--- ${slug} ---\n${ls.filter((l) => /done, |clips|precision|Error|silent|Mode:|Reference|GPU|step|\$ /.test(l)).slice(-40).join('\n')}`);
  }
  if (s.state === 'complete') {
    const out = await runOutputs(auth, slug).catch(() => ({ files: [] as { fileName: string }[] }));
    files = out.files.map((f) => f.fileName).filter((n) => /zip|safetensors|json|wav/.test(n)).slice(0, 6).join(', ');
  }
  console.log(`${slug} | last run ${k.lastRunTime ?? '?'} | ${s.state}${files ? ` | ${files}` : ''}`);
}
