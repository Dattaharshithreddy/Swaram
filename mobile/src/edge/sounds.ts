/**
 * Your sound clips (door, bell, applause…), placed in scripts with
 * [sound: door]. Imported once from any audio file and kept as 24 kHz
 * float32 ready to join.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { SwaramEdge } from '../../modules/swaram-edge';
import { SAMPLE_RATE } from './dsp';

export interface Sound {
  name: string;
  seconds: number;
}

function dir(): Directory {
  const d = new Directory(Paths.document, 'sounds');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

export function soundSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9ఀ-౿]+/g, '-').replace(/^-+|-+$/g, '');
}

export function soundFile(name: string): File {
  return new File(dir(), `${soundSlug(name)}.f32`);
}

export function listSounds(): Sound[] {
  return dir()
    .list()
    .filter((e): e is File => e instanceof File && e.name.endsWith('.f32'))
    .map((f) => ({ name: f.name.replace(/\.f32$/, ''), seconds: (f.size ?? 0) / 4 / SAMPLE_RATE }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function importSound(uri: string, name: string): Promise<Sound> {
  const slug = soundSlug(name);
  if (!slug) throw new Error('Give the sound a short name, like door or bell.');
  if (!SwaramEdge) throw new Error('This app build has no offline engine.');
  const out = soundFile(slug);
  if (out.exists) out.delete();
  const n = await SwaramEdge.decodeAudio(uri, out.uri, 120);
  return { name: slug, seconds: n / SAMPLE_RATE };
}

export function deleteSound(name: string) {
  const f = soundFile(name);
  if (f.exists) f.delete();
}
