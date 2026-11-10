/**
 * GPU server voices outside React: a saved list (so Studio projects still know
 * a server voice's name and language when the server is off), and the maker
 * that turns a Studio line into audio on the server.
 */
import { File, Paths } from 'expo-file-system';
import { api } from '../api';
import { loadServerConfig } from '../settings';
import { SAMPLE_RATE } from './dsp';
import type { PartMaker } from './jobs';
import type { ServerVoice, VoiceRef } from './voices';

export const SERVER_PREFIX = 'server:';

function file() {
  return new File(Paths.document, 'swaram-server-voices.json');
}

export function isServerKey(key: string | undefined): boolean {
  return !!key?.startsWith(SERVER_PREFIX);
}

/** The last list fetched from the server. */
export function listServerVoices(): ServerVoice[] {
  try {
    const f = file();
    return f.exists ? (JSON.parse(f.textSync()) as ServerVoice[]) : [];
  } catch {
    return [];
  }
}

export function rememberServerVoices(voices: ServerVoice[]) {
  try {
    file().writeSync(JSON.stringify(voices.map(({ id, name, language }) => ({ id, name, language }))));
  } catch {
    // Only a cache; the app works without it.
  }
}

export function serverRefs(voices: ServerVoice[] = listServerVoices()): VoiceRef[] {
  return voices.map((voice) => ({ kind: 'server' as const, voice }));
}

/** Decodes a PCM (16-bit or float) WAV to mono float samples at ``rate``. */
export function decodeWav(bytes: Uint8Array, rate = SAMPLE_RATE): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('The server sent audio in an unexpected format.');
  let format = 1;
  let channels = 1;
  let srcRate = rate;
  let bits = 16;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      format = view.getUint16(at + 8, true);
      channels = view.getUint16(at + 10, true);
      srcRate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
    }
    if (id === 'data') {
      const start = at + 8;
      const len = size === 0 || size === 0xffffffff || start + size > bytes.length ? bytes.length - start : size;
      const width = bits / 8;
      const frames = Math.floor(len / (width * channels));
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const p = start + (i * channels + c) * width;
          sum += format === 3 && bits === 32 ? view.getFloat32(p, true) : bits === 16 ? view.getInt16(p, true) / 32768 : 0;
        }
        mono[i] = sum / channels;
      }
      return resample(mono, srcRate, rate);
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('The server sent audio with no sound data.');
}

/** Linear resampling: the server speaks at 24 kHz (IndicF5) or 44.1 kHz (Parler). */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to || x.length === 0) return x;
  const out = new Float32Array(Math.max(1, Math.round((x.length * to) / from)));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const f = pos - j;
    out[i] = (x[j] ?? 0) * (1 - f) + (x[Math.min(j + 1, x.length - 1)] ?? 0) * f;
  }
  return out;
}

/** Makes a Studio line on the GPU server. */
export function serverMaker(voice: ServerVoice, speed = 1): PartMaker {
  return async (text) => {
    const cfg = await loadServerConfig();
    if (!cfg.url) throw new Error('This script uses a ☁ server voice. Connect your GPU server first (Home → GPU server).');
    const bytes = await api.speakWavBytes(cfg, voice.id, text, speed);
    return decodeWav(bytes);
  };
}
