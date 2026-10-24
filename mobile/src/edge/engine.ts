/**
 * Offline voice cloning on the phone: IndicF5 split into four ONNX graphs
 * (see edge/swaram_edge/graphs.py), run by the app's own native module
 * (modules/swaram-edge) on ONNX Runtime's official Android library.
 *
 * The algorithm matches edge/swaram_edge/runner.py, which is tested against
 * the original model: text and duration rules here, the sampling loop in the
 * native module.
 */
import { type Directory, File, Paths } from 'expo-file-system';
import { SwaramEdge } from '../../modules/swaram-edge';
import { crossFade, rms, SAMPLE_RATE, trimSilence, utf8Length } from './dsp';

const HOP = 256;
const N_MELS = 100;
const TARGET_RMS = 0.1;
const MAX_FRAMES = 4096;

export type Provider = 'cpu' | 'xnnpack' | 'nnapi';

export interface EdgeVoiceData {
  mel: Float32Array; // frames * 100, row-major
  frames: number;
  text: string; // normalised reference transcript
  rms: number;
}

export interface SpeakOptions {
  steps?: number;
  cfg?: number;
  sway?: number;
  speed?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface Timing {
  loadSeconds: number;
  contextSeconds: number;
  stepSeconds: number;
  vocoderSeconds: number;
  audioSeconds: number;
  steps: number;
}

export function swaySchedule(steps: number, coef = -1): Float32Array {
  const t = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const x = i / steps;
    t[i] = coef ? x + coef * (Math.cos((Math.PI / 2) * x) - 1 + x) : x;
  }
  return t;
}

/** Same rule as F5-TTS: the reference and the new text read as two sentences. */
export function normalizeRefText(refText: string): string {
  const t = refText.trim();
  if (t.endsWith('。')) return t;
  if (t.endsWith('.')) return `${t} `;
  return `${t}. `;
}

export function chunkText(text: string, maxBytes: number): string[] {
  // Pieces that end in punctuation (no regex lookbehind, for older Hermes).
  const parts = (text.trim().match(/[^;:,.!?।]+(?:[;:,.!?।]+|$)/g) ?? []).map((p) => p.trim());
  const chunks: string[] = [];
  let cur = '';
  for (const part of parts) {
    if (!part) continue;
    const candidate = cur ? `${cur} ${part}` : part;
    if (utf8Length(candidate) <= maxBytes || !cur) cur = candidate;
    else {
      chunks.push(cur);
      cur = part;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function scratch(name: string): File {
  const f = new File(Paths.cache, `swaram-edge-${name}`);
  if (f.exists) f.delete();
  return f;
}

function writeFloats(f: File, data: Float32Array) {
  // Float32Array is little-endian on every Android device.
  f.writeSync(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

async function readFloats(f: File): Promise<Float32Array> {
  const bytes = await f.bytes();
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function native() {
  if (!SwaramEdge) {
    throw new Error('This app build has no offline engine. Install the latest APK from GitHub Releases.');
  }
  return SwaramEdge;
}

export class EdgeEngine {
  private constructor(
    private readonly vocab: Map<string, number>,
    readonly loadSeconds: number,
  ) {}

  static async load(dir: Directory, provider: Provider = 'xnnpack', threads = 4): Promise<EdgeEngine> {
    const ms = await native().load(dir.uri, threads, provider);
    const vocabList: string[] = JSON.parse(await new File(dir, 'vocab.json').text());
    const vocab = new Map(vocabList.map((tok, i) => [tok, i] as [string, number]));
    return new EdgeEngine(vocab, ms / 1000);
  }

  async release(): Promise<void> {
    await native().release();
  }

  /** wav: mono float32 at 24 kHz. */
  async makeVoice(wav: Float32Array, refText: string, maxSeconds = 15): Promise<EdgeVoiceData> {
    let clip = trimSilence(wav).slice(0, Math.floor(maxSeconds * SAMPLE_RATE));
    const level = rms(clip);
    if (level < TARGET_RMS) {
      const g = TARGET_RMS / level;
      clip = clip.map((s) => s * g);
    }
    const wavFile = scratch('ref.f32');
    const melFile = scratch('ref.mel');
    writeFloats(wavFile, clip);
    const frames = await native().computeMel(wavFile.uri, melFile.uri);
    const mel = await readFloats(melFile);
    return {
      mel: mel.slice(0, frames * N_MELS),
      frames,
      text: normalizeRefText(refText),
      rms: level,
    };
  }

  private tokens(text: string): number[] {
    return Array.from(text, (c) => this.vocab.get(c) ?? 0);
  }

  private async speakChunk(
    voice: EdgeVoiceData,
    text: string,
    opts: { steps: number; cfg: number; sway: number; speed: number },
    timing: Timing,
    progress: { done: number; total: number },
    refMelUri: string,
  ) {
    const refFrames = voice.frames;
    const refBytes = Math.max(1, utf8Length(voice.text));
    const ids = this.tokens(voice.text + text);
    let duration = refFrames + Math.floor(((refFrames / refBytes) * utf8Length(text)) / opts.speed);
    duration = Math.min(Math.max(duration, Math.max(ids.length, refFrames) + 1), MAX_FRAMES);

    const outFile = scratch('out.f32');
    const t = await native().synthesize(ids, refMelUri, Array.from(swaySchedule(opts.steps, opts.sway)), outFile.uri, {
      duration,
      refFrames,
      cfg: opts.cfg,
      seed: Math.floor(Math.random() * 2 ** 31),
      progressBase: progress.done,
      progressTotal: progress.total,
    });
    progress.done += opts.steps;

    let out = (await readFloats(outFile)).subarray(0, t.samples);
    if (voice.rms < TARGET_RMS) {
      const g = voice.rms / TARGET_RMS;
      out = out.map((s) => s * g);
    }
    timing.contextSeconds += t.contextMs / 1000;
    timing.stepSeconds += t.stepMs / 1000;
    timing.vocoderSeconds += t.vocoderMs / 1000;
    timing.audioSeconds += out.length / SAMPLE_RATE;
    return out;
  }

  async speak(voice: EdgeVoiceData, text: string, options: SpeakOptions = {}) {
    const opts = { steps: 16, cfg: 2.0, sway: -1.0, speed: 1.0, ...options };
    const timing: Timing = {
      loadSeconds: this.loadSeconds,
      contextSeconds: 0,
      stepSeconds: 0,
      vocoderSeconds: 0,
      audioSeconds: 0,
      steps: opts.steps,
    };
    const refSeconds = (voice.frames * HOP) / SAMPLE_RATE;
    const maxBytes = Math.floor((utf8Length(voice.text) / Math.max(refSeconds, 1e-3)) * (25 - refSeconds));
    const chunks = chunkText(text, Math.max(maxBytes, 60));
    const progress = { done: 0, total: chunks.length * opts.steps };
    const sub = options.onProgress
      ? native().addListener('onProgress', (e) => options.onProgress?.(e.done, e.total))
      : null;
    try {
      const refMel = scratch('cond.mel');
      writeFloats(refMel, voice.mel.subarray(0, voice.frames * N_MELS));
      const pieces: Float32Array[] = [];
      for (const chunk of chunks) pieces.push(await this.speakChunk(voice, chunk, opts, timing, progress, refMel.uri));
      return { wav: crossFade(pieces), timing };
    } finally {
      sub?.remove();
    }
  }
}
