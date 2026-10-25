/**
 * Studio voice ("professional cloning"): the person reads a list of sentences
 * (10-15 minutes), the app uploads them to their private Kaggle dataset and a
 * notebook (cloud/swaram_pro_voice.ipynb) trains the big model itself on that
 * voice. The trained model stays on Kaggle and is used by Studio renders.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { FileSystemUploadType, uploadAsync } from 'expo-file-system/legacy';
import { SwaramEdge } from '../../modules/swaram-edge';
import { encodeWav, SAMPLE_RATE } from './dsp';
import { createPrivateDataset, datasetStatus, type KaggleAuth, pushNotebook } from './kaggle';
import { type Credentials, listTrainings, saveTrainings, type Training } from './kaggleTraining';
import { PRO_SENTENCES } from './proSentences';
import type { OfflineVoice } from './store';

const TEMPLATE_URL = 'https://raw.githubusercontent.com/Dattaharshithreddy/Swaram/main/cloud/swaram_pro_voice.ipynb';
export const PRO_MIN_MINUTES = 8;
export const PRO_GOOD_MINUTES = 12;
export const PRO_HOURS = 2.5;

function dir(v: OfflineVoice): Directory {
  const d = new Directory(Paths.document, 'edge-voices', `${v.id}-pro`);
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

export function proClipFile(v: OfflineVoice, n: number): File {
  return new File(dir(v), `${String(n).padStart(4, '0')}.wav`);
}

export function hasProClip(v: OfflineVoice, n: number): boolean {
  return proClipFile(v, n).exists;
}

export function saveProClip(v: OfflineVoice, n: number, clip: Float32Array) {
  const f = proClipFile(v, n);
  if (f.exists) f.delete();
  f.writeSync(encodeWav(clip));
}

export function deleteProClip(v: OfflineVoice, n: number) {
  const f = proClipFile(v, n);
  if (f.exists) f.delete();
}

/** Minutes recorded so far and how many sentences are done. */
export function proProgress(v: OfflineVoice): { minutes: number; done: number; total: number } {
  let bytes = 0;
  let done = 0;
  for (let n = 0; n < PRO_SENTENCES.length; n++) {
    const f = proClipFile(v, n);
    if (f.exists) {
      bytes += Math.max(0, (f.size ?? 44) - 44);
      done++;
    }
  }
  return { minutes: bytes / 2 / SAMPLE_RATE / 60, done, total: PRO_SENTENCES.length };
}

/** The first sentence not recorded yet (or 0 when all are). */
export function nextProSentence(v: OfflineVoice): number {
  const i = PRO_SENTENCES.findIndex((_, n) => !hasProClip(v, n));
  return i < 0 ? 0 : i;
}

export function deleteProRecordings(v: OfflineVoice) {
  const d = new Directory(Paths.document, 'edge-voices', `${v.id}-pro`);
  if (d.exists) d.delete();
}

/** The recordings as small M4A files plus their words, zipped for upload. */
async function buildPack(v: OfflineVoice, onStep: (text: string) => void): Promise<File> {
  if (!SwaramEdge) throw new Error('This app build cannot prepare recordings.');
  const work = new Directory(Paths.cache, `pro-${v.id}`);
  if (work.exists) work.delete();
  work.create({ intermediates: true, idempotent: true });
  const paths: string[] = [];
  const names: string[] = [];
  const rows: string[] = [];
  for (let n = 0; n < PRO_SENTENCES.length; n++) {
    const src = proClipFile(v, n);
    if (!src.exists) continue;
    onStep(`Preparing recordings… ${rows.length + 1}`);
    const name = `${String(n).padStart(4, '0')}.m4a`;
    const m4a = new File(work, name);
    await SwaramEdge.encodeM4a(src.uri, m4a.uri, 96000);
    paths.push(m4a.uri);
    names.push(`clips/${name}`);
    rows.push(`${name}|${PRO_SENTENCES[n]}`);
  }
  const meta = new File(work, 'metadata.csv');
  meta.writeSync(rows.join('\n'));
  paths.push(meta.uri);
  names.push('metadata.csv');
  const zip = new File(Paths.cache, `swaram-pro-${v.id}.zip`);
  if (zip.exists) zip.delete();
  await SwaramEdge.zip(paths, names, zip.uri);
  work.delete();
  return zip;
}

/** Uploads the recordings and starts training the big model on them. */
export async function startStudioVoice(v: OfflineVoice, creds: Credentials, onStep: (text: string) => void): Promise<Training> {
  if (!creds.username || !creds.token || !creds.hfToken) {
    throw new Error('Add your Kaggle username, Kaggle API token and Hugging Face token in Settings first.');
  }
  const { minutes } = proProgress(v);
  if (minutes < PRO_MIN_MINUTES) throw new Error(`Record at least ${PRO_MIN_MINUTES} minutes first (you have ${minutes.toFixed(1)}).`);
  const auth: KaggleAuth = { username: creds.username, token: creds.token };
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const zip = await buildPack(v, onStep);
  const dataSlug = `swaram-pro-${id}`;
  onStep(`Uploading ${((zip.size ?? 0) / 1e6).toFixed(0)} MB of recordings…`);
  await createPrivateDataset(auth, dataSlug, `Swaram studio voice ${id}`, { name: `swaram-pro-${id}.zip`, bytes: zip.size ?? 0, contentType: 'application/zip' }, async (url) => {
    const res = await uploadAsync(url, zip.uri, { httpMethod: 'PUT', uploadType: FileSystemUploadType.BINARY_CONTENT, headers: { 'Content-Type': 'application/zip' } });
    if (res.status < 200 || res.status >= 300) throw new Error(`Upload failed (HTTP ${res.status}). Try again on Wi-Fi.`);
  });
  zip.delete();
  onStep('Kaggle is processing the recordings…');
  for (let i = 0; i < 60; i++) {
    const s = await datasetStatus(auth, dataSlug).catch(() => '');
    if (s.includes('ready') || s.includes('complete')) break;
    if (s.includes('error') || s.includes('fail')) throw new Error('Kaggle could not process the recordings. Try again.');
    await new Promise((r) => setTimeout(r, 5000));
  }
  onStep('Starting the training…');
  const res = await fetch(`${TEMPLATE_URL}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`Could not get the training notebook (HTTP ${res.status}).`);
  const nb = await res.json();
  const appCell = [
    '# Sent by the Swaram app',
    'import os',
    `os.environ["HF_TOKEN"] = ${JSON.stringify(creds.hfToken.trim())}`,
    `APP_PRO = ${JSON.stringify({ id: v.id, name: v.name, hours: PRO_HOURS })}`,
  ].join('\n');
  nb.cells.splice(1, 0, { cell_type: 'code', metadata: {}, source: appCell, outputs: [], execution_count: null });
  const slug = `swaram-studio-voice-${id}`;
  const pushed = await pushNotebook(auth, slug, nb, { gpu: true, internet: true, timeoutSeconds: 6 * 3600, datasetSources: [dataSlug] });
  const t: Training = {
    id,
    slug,
    username: creds.username.trim(),
    url: pushed.url || `https://www.kaggle.com/code/${creds.username.trim()}/${slug}`,
    voiceName: v.name,
    voiceId: v.id,
    startedAt: Date.now(),
    state: 'running',
    detail: 'Starting on Kaggle…',
    kind: 'big',
    bigFile: `voice-model-${v.id}.safetensors`,
    hours: PRO_HOURS + 0.5,
  };
  saveTrainings([t, ...listTrainings()]);
  return t;
}
