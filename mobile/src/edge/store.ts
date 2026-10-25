/** Offline model download and offline voices, kept in the app's document folder. */
import { Directory, DownloadTask, File, Paths } from 'expo-file-system';
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

export function saveVoice(name: string, language: string, data: EdgeVoiceData): OfflineVoice {
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
  return meta;
}

export async function loadVoiceData(v: OfflineVoice): Promise<EdgeVoiceData> {
  const bytes = await new File(voicesDir(), `${v.id}.mel`).bytes();
  const mel = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { mel, frames: v.frames, text: v.text, rms: v.rms };
}

export function deleteVoice(v: OfflineVoice): void {
  const dir = voicesDir();
  for (const ext of ['json', 'mel']) {
    const f = new File(dir, `${v.id}.${ext}`);
    if (f.exists) f.delete();
  }
}

export function saveAudio(bytes: Uint8Array): File {
  const f = new File(Paths.document, `swaram-offline-${Date.now()}.wav`);
  f.writeSync(bytes);
  return f;
}
