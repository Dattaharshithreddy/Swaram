/** One list of every voice on the phone: big-model voices and ⚡ personal fast voices. */
import { listPersonal, type PersonalVoice } from './personal';
import { listVoices, type OfflineVoice } from './store';

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
