/**
 * Personal fast voices: small Piper/VITS models of one person, trained on
 * Kaggle with personal-voice/swaram_personal_voice.ipynb and imported as a
 * .zip (voice.json, config.json, model.onnx). Much faster than the big
 * model: a sentence takes a fraction of a second.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { SwaramEdge } from '../../modules/swaram-edge';
import { chunkText, readFloats } from './engine';
import { resample, SAMPLE_RATE } from './dsp';
import { teluguPhonemes } from './teluguIpa';

export interface PersonalVoice {
  id: string;
  name: string;
  language: string;
  sampleRate: number;
  createdAt: number;
}

interface PiperConfig {
  audio: { sample_rate: number };
  phoneme_id_map: Record<string, number[]>;
  inference?: { noise_scale?: number; length_scale?: number; noise_w?: number };
}

function edge() {
  if (!SwaramEdge) throw new Error('This app build has no offline engine.');
  return SwaramEdge;
}

function rootDir(): Directory {
  const d = new Directory(Paths.document, 'personal-voices');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

function voiceDir(id: string): Directory {
  return new Directory(rootDir(), id);
}

export function listPersonal(): PersonalVoice[] {
  return rootDir()
    .list()
    .filter((e): e is Directory => e instanceof Directory)
    .map((d) => {
      try {
        return JSON.parse(new File(d, 'swaram.json').textSync()) as PersonalVoice;
      } catch {
        return null;
      }
    })
    .filter((v): v is PersonalVoice => v !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function deletePersonal(v: PersonalVoice) {
  const d = voiceDir(v.id);
  if (d.exists) d.delete();
}

/** Imports a voice pack (.zip from the Kaggle notebook). */
export async function importPersonal(zipUri: string): Promise<PersonalVoice> {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const dir = voiceDir(id);
  dir.create({ intermediates: true, idempotent: true });
  try {
    await edge().unzip(zipUri, dir.uri);
    const meta = new File(dir, 'voice.json');
    if (!meta.exists || !new File(dir, 'model.onnx').exists || !new File(dir, 'config.json').exists) {
      throw new Error('This is not a Swaram voice pack. Use the swaram-voice-….zip from the Kaggle notebook.');
    }
    const info = JSON.parse(meta.textSync()) as { format?: string; name?: string; language?: string; sample_rate?: number };
    if (info.format !== 'swaram-personal/1') throw new Error(`Unsupported voice pack (${info.format ?? 'unknown format'}). Update the app.`);
    const voice: PersonalVoice = {
      id,
      name: info.name || 'Personal voice',
      language: info.language || 'te',
      sampleRate: info.sample_rate || 22050,
      createdAt: Date.now(),
    };
    new File(dir, 'swaram.json').writeSync(JSON.stringify(voice));
    return voice;
  } catch (e) {
    if (dir.exists) dir.delete();
    throw e;
  }
}

function scratch(name: string): File {
  const f = new File(Paths.cache, `swaram-fast-${name}`);
  if (f.exists) f.delete();
  return f;
}

export class FastVoice {
  private constructor(
    readonly voice: PersonalVoice,
    private readonly config: PiperConfig,
    readonly loadSeconds: number,
  ) {}

  static async load(voice: PersonalVoice, threads = 4): Promise<FastVoice> {
    const dir = voiceDir(voice.id);
    const config = JSON.parse(new File(dir, 'config.json').textSync()) as PiperConfig;
    const ms = await edge().piperLoad(new File(dir, 'model.onnx').uri, threads);
    return new FastVoice(voice, config, ms / 1000);
  }

  ids(text: string): number[] {
    const map = this.config.phoneme_id_map;
    const pad = map._[0];
    const ids = [map['^'][0], pad];
    for (const ph of Array.from(teluguPhonemes(text).normalize('NFD'))) {
      const id = map[ph];
      if (id) ids.push(id[0], pad);
    }
    ids.push(map.$[0]);
    return ids;
  }

  /** Parts of a long text, each a sentence or a few (fast voices don't need big parts). */
  chunks(text: string): string[] {
    return chunkText(text, 400);
  }

  /** One part -> 24 kHz audio. text must already be prepared (Telugu script, numbers spelled out). */
  async speakPart(text: string, speed = 1): Promise<Float32Array> {
    const inf = this.config.inference ?? {};
    const out = scratch('out.f32');
    const n = await edge().piperSynth(
      this.ids(text),
      inf.noise_scale ?? 0.667,
      (inf.length_scale ?? 1) / speed,
      inf.noise_w ?? 0.8,
      out.uri,
    );
    const wav = (await readFloats(out)).subarray(0, n);
    return resample(wav, this.config.audio.sample_rate, SAMPLE_RATE);
  }

  async speak(text: string, onProgress?: (done: number, total: number) => void) {
    const t0 = Date.now();
    const parts = this.chunks(text);
    const pieces: Float32Array[] = [];
    for (let i = 0; i < parts.length; i++) {
      pieces.push(await this.speakPart(parts[i]));
      onProgress?.(i + 1, parts.length);
    }
    const total = pieces.reduce((s, p) => s + p.length, 0);
    const wav = new Float32Array(total);
    let o = 0;
    for (const p of pieces) {
      wav.set(p, o);
      o += p.length;
    }
    return { wav, seconds: (Date.now() - t0) / 1000 };
  }
}
