/** One list of every voice on the phone: big-model voices and ⚡ personal fast voices. */
import { listPersonal, type PersonalVoice } from './personal';
import { listVoices, type OfflineVoice } from './store';
import { Directory, File, Paths } from 'expo-file-system';
import { SwaramEdge } from '../../modules/swaram-edge';
import { EMOTIONS } from './emotions';
import { importPersonal as importFast } from './personal';
import { voicesDirectory } from './store';

export type VoiceRef = { kind: 'f5'; voice: OfflineVoice } | { kind: 'fast'; voice: PersonalVoice };

export function keyOf(r: VoiceRef): string {
  return `${r.kind}:${r.voice.id}`;
}

export function listAllVoices(): VoiceRef[] {
  return [
    ...listPersonal().map((voice) => ({ kind: 'fast' as const, voice })),
    ...listVoices().map((voice) => ({ kind: 'f5' as const, voice })),
  ];
}

export function findVoice(key: string | undefined, all = listAllVoices()): VoiceRef | undefined {
  return key ? all.find((r) => keyOf(r) === key) : undefined;
}

export function displayName(r: VoiceRef): string {
  return r.kind === 'fast' ? `⚡ ${r.voice.name}` : r.voice.name;
}

/** Matches a script's speaker label to a voice by name (case- and space-insensitive). */
export function matchSpeaker(label: string, all = listAllVoices()): VoiceRef | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const want = norm(label);
  // Prefer the fast version of a voice when both exist.
  return all.find((r) => norm(r.voice.name) === want);
}

// --- Sharing voices ---------------------------------------------------------


function edge() {
  if (!SwaramEdge) throw new Error('This app build has no offline engine.');
  return SwaramEdge;
}

function safe(name: string) {
  return name.replace(/[^A-Za-z0-9ఀ-౿]+/g, '-').replace(/^-+|-+$/g, '') || 'voice';
}

/** A voice as one file to send to someone (they import it in Voices). Returns its uri. */
export async function exportVoice(r: VoiceRef): Promise<string> {
  const out = new File(Paths.cache, `swaram-voice-${safe(r.voice.name)}.zip`);
  if (out.exists) out.delete();
  if (r.kind === 'fast') {
    const d = new Directory(Paths.document, 'personal-voices', r.voice.id);
    await edge().zip(['voice.json', 'config.json', 'model.onnx'].map((n) => new File(d, n).uri), ['voice.json', 'config.json', 'model.onnx'], out.uri);
    return out.uri;
  }
  const v = r.voice;
  const dir = voicesDirectory();
  const paths: string[] = [new File(dir, `${v.id}.mel`).uri];
  const names: string[] = ['voice.mel'];
  const wav = new File(dir, `${v.id}.wav`);
  if (wav.exists) {
    paths.push(wav.uri);
    names.push('ref.wav');
  }
  for (const e of EMOTIONS) {
    if (!v.emotions?.[e]) continue;
    for (const ext of ['mel', 'wav']) {
      const f = new File(dir, `${v.id}.${e}.${ext}`);
      if (f.exists) {
        paths.push(f.uri);
        names.push(`${e}.${ext}`);
      }
    }
  }
  const meta = new File(Paths.cache, 'voice.json');
  if (meta.exists) meta.delete();
  meta.writeSync(
    JSON.stringify({ format: 'swaram-voice/1', name: v.name, language: v.language, text: v.text, rms: v.rms, frames: v.frames, emotions: v.emotions ?? {} }),
  );
  paths.push(meta.uri);
  names.push('voice.json');
  await edge().zip(paths, names, out.uri);
  return out.uri;
}

/** Imports a shared voice: a big-model voice, or a ⚡ fast voice pack. */
export async function importVoice(zipUri: string): Promise<string> {
  const tmp = new Directory(Paths.cache, `voice-import-${Date.now()}`);
  tmp.create({ intermediates: true, idempotent: true });
  try {
    await edge().unzip(zipUri, tmp.uri);
    const metaFile = new File(tmp, 'voice.json');
    if (!metaFile.exists) throw new Error('This is not a Swaram voice file.');
    const meta = JSON.parse(metaFile.textSync()) as {
      format?: string;
      name?: string;
      language?: string;
      text?: string;
      rms?: number;
      frames?: number;
      emotions?: Record<string, { text: string; frames: number; rms: number }>;
    };
    if (meta.format === 'swaram-personal/1') return (await importFast(zipUri)).name;
    if (meta.format !== 'swaram-voice/1' || !new File(tmp, 'voice.mel').exists) throw new Error('This is not a Swaram voice file.');
    const dir = voicesDirectory();
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    new File(tmp, 'voice.mel').copy(new File(dir, `${id}.mel`));
    if (new File(tmp, 'ref.wav').exists) new File(tmp, 'ref.wav').copy(new File(dir, `${id}.wav`));
    const emotions: Record<string, { text: string; frames: number; rms: number }> = {};
    for (const [e, info] of Object.entries(meta.emotions ?? {})) {
      if (!new File(tmp, `${e}.mel`).exists) continue;
      new File(tmp, `${e}.mel`).copy(new File(dir, `${id}.${e}.mel`));
      if (new File(tmp, `${e}.wav`).exists) new File(tmp, `${e}.wav`).copy(new File(dir, `${id}.${e}.wav`));
      emotions[e] = info;
    }
    const v = {
      id,
      name: meta.name || 'Shared voice',
      language: meta.language || 'te',
      text: meta.text || '',
      rms: meta.rms ?? 0.1,
      frames: meta.frames ?? 0,
      createdAt: Date.now(),
      emotions,
    };
    new File(dir, `${id}.json`).writeSync(JSON.stringify(v));
    return v.name;
  } finally {
    if (tmp.exists) tmp.delete();
  }
}
