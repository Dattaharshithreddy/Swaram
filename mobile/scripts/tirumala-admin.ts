/** Deletes stuck Tirumala render notebooks on Kaggle (frees their GPU slots). Slugs from render/admin.json. */
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync('../render/admin.json', 'utf8'));
const u = (process.env.KAGGLE_USERNAME ?? '').trim(); const tok = (process.env.KAGGLE_API_TOKEN ?? '').trim();
const authHeader = /^[0-9a-f]{32}$/i.test(tok) ? `Basic ${btoa(`${u}:${tok}`)}` : `Bearer ${tok}`;
for (const slug of cfg.delete ?? []) {
  const r = await fetch('https://api.kaggle.com/v1/kernels.KernelsApiService/DeleteKernel', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authHeader },
    body: JSON.stringify({ userName: u, kernelSlug: slug }) });
  console.log('delete', slug, r.status, (await r.text()).slice(0, 200));
}
