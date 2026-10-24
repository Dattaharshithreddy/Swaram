import { requireOptionalNativeModule } from 'expo';

export interface SynthOptions {
  duration: number;
  refFrames: number;
  cfg: number;
  progressBase: number;
  progressTotal: number;
  /** ids.length */
  tokens: number;
  /** schedule.length - 1 */
  steps: number;
}

export interface SynthTiming {
  contextMs: number;
  stepMs: number;
  vocoderMs: number;
  samples: number;
}

export interface SwaramEdgeNative {
  load(dir: string, threads: number, provider: string): Promise<number>;
  release(): Promise<void>;
  computeMel(wav: Float32Array, wavLength: number, out: Float32Array, outLength: number): Promise<number>;
  synthesize(
    ids: Int32Array,
    cond: Float32Array,
    schedule: Float32Array,
    noise: Float32Array,
    outWav: Float32Array,
    opts: SynthOptions,
  ): Promise<SynthTiming>;
  addListener(event: 'onProgress', listener: (e: { done: number; total: number }) => void): { remove(): void };
}

/** null when the app was built without the native module. */
export const SwaramEdge = requireOptionalNativeModule<SwaramEdgeNative>('SwaramEdge');
