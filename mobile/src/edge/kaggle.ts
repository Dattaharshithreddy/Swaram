/**
 * Kaggle API, just the calls Swaram needs: push a notebook and run it on a
 * free GPU, check its status, list its output files. Plain fetch, so the
 * same code runs in the app and in CI (mobile/scripts/kaggle-api-test.ts).
 *
 * Endpoints and field names follow Kaggle's official client (kagglesdk):
 * POST https://api.kaggle.com/v1/kernels.KernelsApiService/<Method>.
 */

export interface KaggleAuth {
  username: string;
  /** An API token from kaggle.com/settings/api, or a legacy kaggle.json key. */
  token: string;
}

const API = 'https://api.kaggle.com/v1';
const TEMPLATE_URL =
  'https://raw.githubusercontent.com/Dattaharshithreddy/Swaram/main/personal-voice/swaram_personal_voice.ipynb';

function authHeader(auth: KaggleAuth): string {
  const token = auth.token.trim();
  // Legacy keys (kaggle.json) are 32 hex characters and use basic auth.
  if (/^[0-9a-f]{32}$/i.test(token)) return `Basic ${btoa(`${auth.username.trim()}:${token}`)}`;
  return `Bearer ${token}`;
}

async function call<T>(auth: KaggleAuth, method: string, body: object): Promise<T> {
  const res = await fetch(`${API}/kernels.KernelsApiService/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authHeader(auth) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new Error('Kaggle did not accept the username or API token. Check them in Settings (kaggle.com/settings/api).');
  }
  if (!res.ok) throw new Error(`Kaggle ${method} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface PushResult {
  ref?: string;
  url?: string;
  versionNumber?: number;
  error?: string;
}

/** Saves the notebook under username/slug and starts a run ("Save & Run All"). */
export async function pushNotebook(
  auth: KaggleAuth,
  slug: string,
  notebook: { cells: { cell_type: string; source: string | string[] }[] },
  opts: { gpu: boolean; internet: boolean; timeoutSeconds?: number },
): Promise<PushResult> {
  const nb = JSON.parse(JSON.stringify(notebook));
  for (const cell of nb.cells) {
    if (Array.isArray(cell.source)) cell.source = cell.source.join('');
    if (cell.cell_type === 'code') cell.outputs = [];
  }
  const res = await call<PushResult>(auth, 'SaveKernel', {
    slug: `${auth.username.trim()}/${slug}`,
    newTitle: slug.replace(/-/g, ' '),
    text: JSON.stringify(nb),
    language: 'python',
    kernelType: 'notebook',
    isPrivate: true,
    enableGpu: opts.gpu,
    enableInternet: opts.internet,
    ...(opts.gpu ? { machineShape: 'NvidiaTeslaT4' } : {}),
    ...(opts.timeoutSeconds ? { sessionTimeoutSeconds: opts.timeoutSeconds } : {}),
  });
  if (res.error) throw new Error(`Kaggle refused the notebook: ${res.error}`);
  return res;
}

export type RunState = 'queued' | 'running' | 'complete' | 'error' | 'cancelled' | 'unknown';

export async function runStatus(auth: KaggleAuth, slug: string): Promise<{ state: RunState; raw: string; message?: string }> {
  const res = await call<{ status?: string | number; failureMessage?: string }>(auth, 'GetKernelSessionStatus', {
    userName: auth.username.trim(),
    kernelSlug: slug,
  });
  const raw = String(res.status ?? '').toUpperCase();
  const state: RunState =
    raw.includes('COMPLETE') || raw === '2'
      ? 'complete'
      : raw.includes('ERROR') || raw === '3'
        ? 'error'
        : raw.includes('CANCEL') || raw === '4' || raw === '5'
          ? 'cancelled'
          : raw.includes('RUNNING') || raw === '1'
            ? 'running'
            : raw.includes('QUEUED') || raw.includes('NEW') || raw === '0' || raw === '6'
              ? 'queued'
              : 'unknown';
  return { state, raw, message: res.failureMessage || undefined };
}

export async function runOutputs(auth: KaggleAuth, slug: string): Promise<{ files: { url: string; fileName: string }[]; log?: string }> {
  const files: { url: string; fileName: string }[] = [];
  let pageToken: string | undefined;
  let log: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await call<{ files?: { url: string; fileName: string }[]; log?: string; nextPageToken?: string }>(
      auth,
      'ListKernelSessionOutput',
      { userName: auth.username.trim(), kernelSlug: slug, pageSize: 100, ...(pageToken ? { pageToken } : {}) },
    );
    files.push(...(res.files ?? []));
    log = log ?? res.log;
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return { files, log };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function fetchTemplate(): Promise<{ cells: { cell_type: string; source: string | string[]; metadata?: object }[] }> {
  const res = await fetch(`${TEMPLATE_URL}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`Could not get the training notebook (HTTP ${res.status}).`);
  return res.json();
}

/** The training notebook with the voice and Hugging Face token filled in (the notebook is private). */
export function trainingNotebook(
  template: { cells: { cell_type: string; source: string | string[]; metadata?: object }[] },
  voice: { name: string; language: string; text: string; wavBase64: string },
  hfToken: string,
) {
  const nb = JSON.parse(JSON.stringify(template));
  const appCell = [
    '# Sent by the Swaram app',
    'import os',
    `os.environ["HF_TOKEN"] = ${JSON.stringify(hfToken.trim())}`,
    `APP_VOICE = ${JSON.stringify({ name: voice.name, language: voice.language, text: voice.text, wav_base64: voice.wavBase64 })}`,
  ].join('\n');
  nb.cells.splice(1, 0, { cell_type: 'code', metadata: {}, source: appCell, outputs: [], execution_count: null });
  return nb;
}
