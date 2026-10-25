import { requireOptionalNativeModule } from 'expo';

export interface SynthOptions {
  duration: number;
  refFrames: number;
  cfg: number;
  /** Seed for the starting noise. */
  seed: number;
  /** The first `guided` steps use guidance (two branches); later steps run one branch. */
  guided: number;
  progressBase: number;
  progressTotal: number;
}

export interface SynthTiming {
  contextMs: number;
  stepMs: number;
  vocoderMs: number;
  samples: number;
}

/**
 * Audio and mels are passed as file paths holding little-endian float32
 * values, so the native side never touches JS memory off the JS thread.
 */
export interface SwaramEdgeNative {
  load(dir: string, threads: number, provider: string): Promise<number>;
  release(): Promise<void>;
  computeMel(wavPath: string, melPath: string): Promise<number>;
  synthesize(ids: number[], refMelPath: string, schedule: number[], outPath: string, opts: SynthOptions): Promise<SynthTiming>;
  /** How the app last ended, if that was a crash (shown once); otherwise null. */
  crashReport(): string | null;
  addListener(event: 'onProgress', listener: (e: { done: number; total: number }) => void): { remove(): void };
}

/** null when the app was built without the native module. */
export const SwaramEdge = requireOptionalNativeModule<SwaramEdgeNative>('SwaramEdge');
