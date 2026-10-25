/**
 * Train a personal fast voice on Kaggle from the app: send the voice's
 * recording in a private notebook run on a free GPU, check on it later, and
 * import the result automatically when it's done.
 */
import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import {
  bytesToBase64,
  fetchTemplate,
  type KaggleAuth,
  pushNotebook,
  runOutputs,
  runStatus,
  TRAINING_HOURS,
  type TrainingMode,
  trainingNotebook,
} from './kaggle';
import { importPersonal } from './personal';
import type { Emotion } from './emotions';
import { emotionRecording, type OfflineVoice, recordingFile } from './store';

export interface Training {
  id: string;
  slug: string;
  username: string;
  url?: string;
  voiceName: string;
  /** The big-model voice it was trained from. */
  voiceId?: string;
  startedAt: number;
  state: 'running' | 'done' | 'failed';
  detail?: string;
  personalId?: string;
  checkedAt?: number;
  /** Expected total hours on Kaggle (older trainings: 4). */
  hours?: number;
  mode?: TrainingMode;
  /** 'big': the big model trained on this voice (used when rendering on Kaggle); default: a ⚡ fast voice. */
  kind?: 'fast' | 'big';
  /** big: the trained weights' file name in that notebook's output. */
  bigFile?: string;
}

/** A finished big-model training for this voice key ("f5:<id>"), for studio renders. */
export function trainedBigVoice(voiceKey: string): { slug: string; file: string } | undefined {
  const id = voiceKey.startsWith('f5:') ? voiceKey.slice(3) : '';
  const t = listTrainings().find((x) => x.kind === 'big' && x.state === 'done' && x.voiceId === id && x.bigFile);
  return t ? { slug: t.slug, file: t.bigFile as string } : undefined;
}

export function expectedHours(t: Training): number {
  return t.hours ?? 4;
}

export interface Credentials {
  username: string;
  token: string;
  hfToken: string;
}

const KEYS = { username: 'kaggle-username', token: 'kaggle-token', hfToken: 'hf-token' } as const;

export async function loadCredentials(): Promise<Credentials> {
  const get = (k: string) => SecureStore.getItemAsync(k).catch(() => null);
  const [username, token, hfToken] = await Promise.all([get(KEYS.username), get(KEYS.token), get(KEYS.hfToken)]);
  return { username: username ?? '', token: token ?? '', hfToken: hfToken ?? '' };
}

export async function saveCredentials(c: Credentials): Promise<void> {
  await SecureStore.setItemAsync(KEYS.username, c.username.trim());
  await SecureStore.setItemAsync(KEYS.token, c.token.trim());
  await SecureStore.setItemAsync(KEYS.hfToken, c.hfToken.trim());
}

function storeFile(): File {
  return new File(Paths.document, 'kaggle-trainings.json');
}

export function listTrainings(): Training[] {
  try {
    const f = storeFile();
    return f.exists ? (JSON.parse(f.textSync()) as Training[]) : [];
  } catch {
    return [];
  }
}

function saveAll(list: Training[]) {
  storeFile().writeSync(JSON.stringify(list));
}

export function saveTrainings(list: Training[]) {
  saveAll(list);
}

function update(t: Training) {
  saveAll(listTrainings().map((x) => (x.id === t.id ? t : x)));
}

export function forgetTraining(t: Training) {
  saveAll(listTrainings().filter((x) => x.id !== t.id));
}

export async function startTraining(voice: OfflineVoice, creds: Credentials, mode: TrainingMode = 'best'): Promise<Training> {
  if (!creds.username || !creds.token || !creds.hfToken) {
    throw new Error('Add your Kaggle username, Kaggle API token and Hugging Face token first.');
  }
  const wav = recordingFile(voice);
  if (!wav.exists) throw new Error('This voice has no saved recording. Make the voice again to train it.');
  const template = await fetchTemplate();
  const emotions: Record<string, { text: string; wavBase64: string }> = {};
  for (const [e, info] of Object.entries(voice.emotions ?? {})) {
    const f = emotionRecording(voice, e as Emotion);
    if (info && f.exists) emotions[e] = { text: info.text.trim(), wavBase64: bytesToBase64(await f.bytes()) };
  }
  const nb = trainingNotebook(
    template,
    { name: voice.name, language: voice.language, text: voice.text.trim(), wavBase64: bytesToBase64(await wav.bytes()), emotions },
    creds.hfToken,
    mode,
  );
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const slug = `swaram-voice-${id}`;
  const auth: KaggleAuth = { username: creds.username, token: creds.token };
  const res = await pushNotebook(auth, slug, nb, { gpu: true, internet: true, timeoutSeconds: 11 * 3600 });
  const t: Training = {
    id,
    slug,
    username: creds.username.trim(),
    url: res.url || `https://www.kaggle.com/code/${creds.username.trim()}/${slug}`,
    voiceName: voice.name,
    voiceId: voice.id,
    startedAt: Date.now(),
    state: 'running',
    detail: 'Starting on Kaggle…',
    mode,
    hours: TRAINING_HOURS[mode],
  };
  saveAll([t, ...listTrainings()]);
  return t;
}

/** Checks a running training; imports the voice when it's finished. */
export async function checkTraining(t: Training, creds: Credentials): Promise<Training> {
  if (t.state !== 'running') return t;
  const auth: KaggleAuth = { username: creds.username || t.username, token: creds.token };
  const s = await runStatus(auth, t.slug);
  const next: Training = { ...t, checkedAt: Date.now() };
  if (s.state === 'complete' && t.kind === 'big') {
    // A studio voice stays on Kaggle; Studio renders load it from this notebook's output.
    const out = await runOutputs(auth, t.slug);
    const ok = out.files.some((f) => f.fileName.endsWith(t.bigFile ?? 'voice-model'));
    next.state = ok ? 'done' : 'failed';
    next.detail = ok ? `Studio voice ready: renders on Kaggle now use it` : 'Kaggle finished but made no trained voice. Open the notebook on Kaggle to see what happened.';
  } else if (s.state === 'complete') {
    const out = await runOutputs(auth, t.slug);
    const pack = out.files.find((f) => /swaram-voice-.*\.zip$/.test(f.fileName));
    if (!pack) {
      next.state = 'failed';
      next.detail = 'Kaggle finished but made no voice file. Open the notebook on Kaggle to see what happened.';
    } else {
      next.detail = 'Downloading the voice…';
      const dest = new File(Paths.cache, 'kaggle-voice.zip');
      if (dest.exists) dest.delete();
      await File.downloadFileAsync(pack.url, dest);
      const voice = await importPersonal(dest.uri);
      dest.delete();
      next.state = 'done';
      next.personalId = voice.id;
      next.detail = `Ready: ⚡ ${voice.name}`;
    }
  } else if (s.state === 'error' || s.state === 'cancelled') {
    next.state = 'failed';
    next.detail = s.message || (s.state === 'cancelled' ? 'The run was cancelled on Kaggle.' : 'The run failed on Kaggle. Open it there to see the log.');
  } else {
    const hours = (Date.now() - t.startedAt) / 3.6e6;
    next.detail =
      s.state === 'queued'
        ? 'Waiting for a free GPU on Kaggle…'
        : `${t.kind === 'big' ? 'Training the studio voice' : 'Training on Kaggle'} · ${hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`} so far (about ${expectedHours(t)} h in total)`;
  }
  update(next);
  return next;
}
