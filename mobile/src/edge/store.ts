/** Offline model download and offline voices, kept in the app's document folder. */
import { Directory, DownloadTask, File, Paths } from 'expo-file-system';
import { SwaramEdge } from '../../modules/swaram-edge';
import { encodeWav } from './dsp';
import { type Emotion, EMOTIONS } from './emotions';
import type { EdgeVoiceData } from './engine';

export const MODEL_BASE_URL = 'https://github.com/Dattaharshithreddy/Swaram/releases/download/edge-model/';
export const MODEL_FILES = ['manifest.json', 'vocab.json', 'mel.onnx', 'context.onnx', 'vocoder.onnx', 'flow.int8.onnx'];
/** Files from older model versions, removed on the next download to free space. */
const STALE_FILES = ['step.int8.onnx'];

export function modelDir(): Directory {
  return new Directory(Paths.document, 'edge-model');
}

function voicesDir(): Directory {
  const d = new Directory(Paths.document, 'edge-voices');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

interface Manifest {
  files: Record<string, { bytes: number; sha256: string }>;
}

export function modelInstalled(): boolean {
  const dir = modelDir();
  if (!dir.exists) return false;
  const manifestFile = new File(dir, 'manifest.json');
  if (!manifestFile.exists) return false;
  try {
    const manifest: Manifest = JSON.parse(manifestFile.textSync());
    return MODEL_FILES.filter((f) => f.endsWith('.onnx')).every((name) => {
      const f = new File(dir, name);
      return f.exists && f.size === manifest.files[name]?.bytes;
    });
  } catch {
    return false;
  }
}

/** A model from an older app version is on the phone; only the changed part needs downloading. */
export function modelNeedsUpdate(): boolean {
  const dir = modelDir();
  return dir.exists && STALE_FILES.some((n) => new File(dir, n).exists);
}

export function installedBytes(): number {
  const dir = modelDir();
  if (!dir.exists) return 0;
  return MODEL_FILES.reduce((sum, name) => {
    const f = new File(dir, name);
    return sum + (f.exists ? (f.size ?? 0) : 0);
  }, 0);
}

export function deleteModel(): void {
  const dir = modelDir();
  if (dir.exists) dir.delete();
}

/**
 * Download the model files (~450 MB). Files already complete are skipped,
 * so an interrupted download resumes where it stopped.
 */
export async function downloadModel(onProgress: (bytes: number, total: number, file: string) => void, signal?: { cancelled: boolean }) {
  const dir = modelDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });

  const manifestFile = new File(dir, 'manifest.json');
  const res = await fetch(MODEL_BASE_URL + 'manifest.json');
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? 'The offline model has not been published yet. Run the "Edge model" workflow on GitHub first.'
        : `Could not get the model list (HTTP ${res.status}).`,
    );
  }
  const manifestText = await res.text();
  const manifest: Manifest = JSON.parse(manifestText);
  if (manifestFile.exists) manifestFile.delete();
  manifestFile.writeSync(manifestText);

  for (const name of STALE_FILES) {
    const old = new File(dir, name);
    if (old.exists) old.delete();
  }

  const binaries = MODEL_FILES.filter((f) => f !== 'manifest.json');
  const total = binaries.reduce((s, n) => s + (manifest.files[n]?.bytes ?? 0), 0);
  let done = 0;
  for (const name of binaries) {
    if (signal?.cancelled) throw new Error('Download cancelled');
    const target = new File(dir, name);
    const expected = manifest.files[name]?.bytes;
    if (target.exists && expected !== undefined && target.size === expected) {
      done += expected;
      onProgress(done, total, name);
      continue;
    }
    if (target.exists) target.delete();
    const task = new DownloadTask(MODEL_BASE_URL + name, target);
    const sub = task.addListener('progress', (p) => onProgress(done + p.bytesWritten, total, name));
    try {
      const file = await task.downloadAsync();
      if (!file) throw new Error('Download cancelled');
    } finally {
      sub.remove();
    }
    if (expected !== undefined && target.size !== expected) {
      throw new Error(`${name} did not download completely. Try again on Wi-Fi.`);
    }
    done += target.size ?? 0;
    onProgress(done, total, name);
  }
}

// --- Offline voices ---------------------------------------------------------

export interface OfflineVoice {
  id: string;
  name: string;
  language: string;
  text: string;
  rms: number;
  frames: number;
  createdAt: number;
  /** Extra recordings in other tones (see emotions.ts): words, length and level of each. */
  emotions?: Partial<Record<Emotion, { text: string; frames: number; rms: number }>>;
}

export function listVoices(): OfflineVoice[] {
  const dir = voicesDir();
  return dir
    .list()
    .filter((e): e is File => e instanceof File && e.name.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(f.textSync()) as OfflineVoice;
      } catch {
        return null;
      }
    })
    .filter((v): v is OfflineVoice => v !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function saveVoice(name: string, language: string, data: EdgeVoiceData, clip?: Float32Array): OfflineVoice {
  const dir = voicesDir();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const meta: OfflineVoice = {
    id,
    name,
    language,
    text: data.text,
    rms: data.rms,
    frames: data.frames,
    createdAt: Date.now(),
  };
  new File(dir, `${id}.mel`).writeSync(new Uint8Array(data.mel.buffer, data.mel.byteOffset, data.mel.byteLength));
  new File(dir, `${id}.json`).writeSync(JSON.stringify(meta));
  // The recording itself, for training a personal fast voice later.
  if (clip) new File(dir, `${id}.wav`).writeSync(encodeWav(clip));
  return meta;
}

export async function loadVoiceData(v: OfflineVoice): Promise<EdgeVoiceData> {
  const bytes = await new File(voicesDir(), `${v.id}.mel`).bytes();
  const mel = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { mel, frames: v.frames, text: v.text, rms: v.rms };
}

export function recordingFile(v: OfflineVoice): File {
  return new File(voicesDir(), `${v.id}.wav`);
}

export function hasRecording(v: OfflineVoice): boolean {
  return recordingFile(v).exists;
}

/** A zip with the recording and its words, to upload to the Kaggle notebook. Returns its uri. */
export async function exportForTraining(v: OfflineVoice): Promise<string> {
  const edge = SwaramEdge;
  if (!edge) throw new Error('This app build has no offline engine.');
  const paths = [new File(voicesDir(), `${v.id}.wav`).uri];
  const names = ['ref.wav'];
  const emotions: Record<string, { audio: string; text: string }> = {};
  for (const e of EMOTIONS) {
    const info = v.emotions?.[e];
    const f = new File(voicesDir(), `${v.id}.${e}.wav`);
    if (info && f.exists) {
      paths.push(f.uri);
      names.push(`emo-${e}.wav`);
      emotions[e] = { audio: `emo-${e}.wav`, text: info.text.trim() };
    }
  }
  const meta = new File(Paths.cache, 'voice.json');
  if (meta.exists) meta.delete();
  meta.writeSync(JSON.stringify({ name: v.name, language: v.language, text: v.text.trim(), audio: 'ref.wav', emotions }));
  paths.push(meta.uri);
  names.push('voice.json');
  const safe = v.name.replace(/[^A-Za-z0-9\u0C00-\u0C7F]+/g, '-').replace(/^-+|-+$/g, '') || 'voice';
  const out = new File(Paths.cache, `swaram-training-${safe}.zip`);
  if (out.exists) out.delete();
  await edge.zip(paths, names, out.uri);
  return out.uri;
}

export function deleteVoice(v: OfflineVoice): void {
  const dir = voicesDir();
  for (const ext of ['json', 'mel', 'wav']) {
    const f = new File(dir, `${v.id}.${ext}`);
    if (f.exists) f.delete();
  }
  for (const e of EMOTIONS) deleteEmotionFiles(v.id, e);
}

// --- Emotion recordings -------------------------------------------------------

function deleteEmotionFiles(id: string, e: Emotion) {
  for (const ext of ['mel', 'wav']) {
    const f = new File(voicesDir(), `${id}.${e}.${ext}`);
    if (f.exists) f.delete();
  }
}

function writeMeta(v: OfflineVoice) {
  new File(voicesDir(), `${v.id}.json`).writeSync(JSON.stringify(v));
}

export function saveEmotion(v: OfflineVoice, e: Emotion, data: EdgeVoiceData, clip: Float32Array): OfflineVoice {
  const dir = voicesDir();
  new File(dir, `${v.id}.${e}.mel`).writeSync(new Uint8Array(data.mel.buffer, data.mel.byteOffset, data.mel.byteLength));
  new File(dir, `${v.id}.${e}.wav`).writeSync(encodeWav(clip));
  const next: OfflineVoice = { ...v, emotions: { ...(v.emotions ?? {}), [e]: { text: data.text, frames: data.frames, rms: data.rms } } };
  writeMeta(next);
  return next;
}

export function deleteEmotion(v: OfflineVoice, e: Emotion): OfflineVoice {
  deleteEmotionFiles(v.id, e);
  const emotions = { ...(v.emotions ?? {}) };
  delete emotions[e];
  const next = { ...v, emotions };
  writeMeta(next);
  return next;
}

export function emotionRecording(v: OfflineVoice, e: Emotion): File {
  return new File(voicesDir(), `${v.id}.${e}.wav`);
}

/** The voice in that tone, if it has a recording for it. */
export async function loadEmotionData(v: OfflineVoice, e: Emotion): Promise<EdgeVoiceData | null> {
  const info = v.emotions?.[e];
  const f = new File(voicesDir(), `${v.id}.${e}.mel`);
  if (!info || !f.exists) return null;
  const bytes = await f.bytes();
  const mel = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { mel, frames: info.frames, text: info.text, rms: info.rms };
}

export function saveAudio(bytes: Uint8Array): File {
  const f = new File(Paths.document, `swaram-offline-${Date.now()}.wav`);
  f.writeSync(bytes);
  return f;
}
