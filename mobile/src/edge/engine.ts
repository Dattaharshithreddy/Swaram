/**
 * Offline voice cloning on the phone: IndicF5 split into four ONNX graphs
 * (see edge/swaram_edge/graphs.py). This is a line-for-line port of
 * edge/swaram_edge/runner.py, which is tested against the original model.
 */
import { File, type Directory } from 'expo-file-system';
import type { InferenceSession as InferenceSessionType, Tensor as TensorType } from 'onnxruntime-react-native';

type Ort = typeof import('onnxruntime-react-native');
let ort: Ort | null = null;

/**
 * Load ONNX Runtime only when the offline engine is used. Importing it at app
 * start runs its native setup, and if that fails the whole app would crash on
 * launch; loaded here, a failure is a message in the Offline tab instead.
 */
export function loadOrt(): Ort {
  if (ort) return ort;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod: Ort = require('onnxruntime-react-native');
    mod.listSupportedBackends(); // throws if the native part did not start
    ort = mod;
    return mod;
  } catch (e) {
    throw new Error(
      `The offline engine could not start on this phone (${e instanceof Error ? e.message : String(e)}). ` +
        'Use the server mode for now.',
    );
  }
}
import { crossFade, gaussian, rms, SAMPLE_RATE, trimSilence, utf8Length } from './dsp';

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
  shouldStop?: () => boolean;
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

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

export class EdgeEngine {
  private constructor(
    private readonly ort: Ort,
    private readonly mel: InferenceSessionType,
    private readonly context: InferenceSessionType,
    private readonly step: InferenceSessionType,
    private readonly vocoder: InferenceSessionType,
    private readonly vocab: Map<string, number>,
    readonly loadSeconds: number,
  ) {}

  static async load(dir: Directory, provider: Provider = 'xnnpack', threads = 4): Promise<EdgeEngine> {
    const t0 = now();
    const ort = loadOrt();
    const options: InferenceSessionType.SessionOptions = {
      executionProviders: provider === 'cpu' ? ['cpu'] : [provider, 'cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: threads,
    };
    const open = (name: string) => ort.InferenceSession.create(new File(dir, name).uri, options);
    // The big step graph and the small ones load in parallel.
    const [mel, context, step, vocoder] = await Promise.all([
      open('mel.onnx'),
      open('context.onnx'),
      open('step.int8.onnx'),
      open('vocoder.onnx'),
    ]);
    const vocabList: string[] = JSON.parse(await new File(dir, 'vocab.json').text());
    const vocab = new Map(vocabList.map((tok, i) => [tok, i] as [string, number]));
    return new EdgeEngine(ort, mel, context, step, vocoder, vocab, now() - t0);
  }

  async release(): Promise<void> {
    await Promise.all([this.mel.release(), this.context.release(), this.step.release(), this.vocoder.release()]);
  }

  /** wav: mono float32 at 24 kHz. */
  async makeVoice(wav: Float32Array, refText: string, maxSeconds = 15): Promise<EdgeVoiceData> {
    let clip = trimSilence(wav).slice(0, Math.floor(maxSeconds * SAMPLE_RATE));
    const level = rms(clip);
    if (level < TARGET_RMS) {
      const g = TARGET_RMS / level;
      clip = clip.map((s) => s * g);
    }
    const out = await this.mel.run({ wav: new this.ort.Tensor('float32', clip, [1, clip.length]) });
    const mel = out.mel;
    return {
      mel: new Float32Array(mel.data as Float32Array),
      frames: mel.dims[1],
      text: normalizeRefText(refText),
      rms: level,
    };
  }

  private tokens(text: string): TensorType {
    const chars = Array.from(text);
    const ids = new BigInt64Array(chars.length);
    chars.forEach((c, i) => {
      ids[i] = BigInt(this.vocab.get(c) ?? 0);
    });
    return new this.ort.Tensor('int64', ids, [1, chars.length]);
  }

  private async speakChunk(voice: EdgeVoiceData, text: string, opts: Required<Omit<SpeakOptions, 'onProgress' | 'shouldStop'>> & SpeakOptions, timing: Timing, offset: { done: number; total: number }) {
    const refFrames = voice.frames;
    const refBytes = Math.max(1, utf8Length(voice.text));
    const ids = this.tokens(voice.text + text);
    let duration = refFrames + Math.floor(((refFrames / refBytes) * utf8Length(text)) / opts.speed);
    duration = Math.min(Math.max(duration, Math.max(ids.dims[1], refFrames) + 1), MAX_FRAMES);

    const cond = new Float32Array(duration * N_MELS);
    cond.set(voice.mel.subarray(0, refFrames * N_MELS), 0);
    let t0 = now();
    const ctx = (await this.context.run({ text: ids, cond: new this.ort.Tensor('float32', cond, [1, duration, N_MELS]) })).ctx;
    timing.contextSeconds += now() - t0;

    t0 = now();
    const x = gaussian(duration * N_MELS);
    const ts = swaySchedule(opts.steps, opts.sway);
    const cfg = new this.ort.Tensor('float32', new Float32Array([opts.cfg]), [1]);
    for (let i = 0; i < opts.steps; i++) {
      if (opts.shouldStop?.()) throw new Error('Stopped');
      const out = await this.step.run({
        x: new this.ort.Tensor('float32', x, [1, duration, N_MELS]),
        ctx,
        t: new this.ort.Tensor('float32', new Float32Array([ts[i]]), [1]),
        cfg,
      });
      const v = out.v.data as Float32Array;
      const dt = ts[i + 1] - ts[i];
      for (let j = 0; j < x.length; j++) x[j] += dt * v[j];
      offset.done += 1;
      opts.onProgress?.(offset.done, offset.total);
    }
    timing.stepSeconds += now() - t0;

    // Generated part only, transposed to (1, mels, frames) for the vocoder.
    t0 = now();
    const gen = duration - refFrames;
    const melT = new Float32Array(N_MELS * gen);
    for (let f = 0; f < gen; f++) {
      const row = (refFrames + f) * N_MELS;
      for (let m = 0; m < N_MELS; m++) melT[m * gen + f] = x[row + m];
    }
    const wavOut = (await this.vocoder.run({ mel: new this.ort.Tensor('float32', melT, [1, N_MELS, gen]) })).wav;
    let wav = new Float32Array(wavOut.data as Float32Array);
    if (voice.rms < TARGET_RMS) {
      const g = voice.rms / TARGET_RMS;
      wav = wav.map((s) => s * g);
    }
    timing.vocoderSeconds += now() - t0;
    timing.audioSeconds += wav.length / SAMPLE_RATE;
    return wav;
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
    const pieces: Float32Array[] = [];
    for (const chunk of chunks) pieces.push(await this.speakChunk(voice, chunk, opts, timing, progress));
    return { wav: crossFade(pieces), timing };
  }
}
