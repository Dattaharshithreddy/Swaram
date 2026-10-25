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
  /** flow: 'flow.int8.onnx' (normal) or 'flow.onnx' (Studio quality). */
  load(dir: string, threads: number, provider: string, flow: string): Promise<number>;
  release(): Promise<void>;
  computeMel(wavPath: string, melPath: string): Promise<number>;
  synthesize(ids: number[], refMelPath: string, schedule: number[], outPath: string, opts: SynthOptions): Promise<SynthTiming>;
  /** Any audio file Android can play -> mono float32 at 24 kHz in outPath. Returns samples. */
  decodeAudio(src: string, outPath: string, maxSeconds: number): Promise<number>;
  /** Music under a voice WAV (looped, ducked under speech, faded). Returns samples. */
  mixMusic(voiceWav: string, music: string, outWav: string, gain: number, duck: boolean, fadeSec: number): Promise<number>;
  /** Reduces steady background noise in a float32 file (strength 0-1). Returns samples. */
  denoise(inPath: string, outPath: string, strength: number): Promise<number>;
  /** Studio finishing: EQ, compression, loudness to about -16 LUFS, limiter. 16-bit WAV in and out (in place is fine). */
  polish(inPath: string, outPath: string): Promise<number>;
  /** A video with its sound replaced by the .m4a. */
  muxVideo(video: string, audioM4a: string, outMp4: string): Promise<number>;
  /** 16-bit WAV -> AAC .m4a. Returns samples. */
  encodeM4a(wavPath: string, outPath: string, bitrate: number): Promise<number>;
  /** Joins float32 part files into one 16-bit WAV with cross-fades. Returns samples. */
  joinWav(parts: string[], outPath: string, fadeSamples: number): Promise<number>;
  /** Foreground service + wake lock so generation continues with the screen off. */
  startBackground(title: string, text: string): boolean;
  updateBackground(title: string, text: string, done: number, total: number): void;
  stopBackground(): void;
  requestNotifications(): void;
  /** Personal fast voice (Piper/VITS ONNX). */
  piperLoad(modelPath: string, threads: number): Promise<number>;
  piperSynth(modelPath: string, ids: number[], noiseScale: number, lengthScale: number, noiseW: number, outPath: string): Promise<number>;
  /** Copies a file to Downloads/Swaram. Returns where it went. */
  saveToDownloads(src: string, displayName: string, mime: string): Promise<string>;
  unzip(zipPath: string, destDir: string): Promise<string[]>;
  zip(paths: string[], names: string[], outPath: string): Promise<void>;
  /** How the app last ended, if that was a crash (shown once); otherwise null. */
  crashReport(): string | null;
  addListener(event: 'onProgress', listener: (e: { done: number; total: number }) => void): { remove(): void };
}

/** null when the app was built without the native module. */
export const SwaramEdge = requireOptionalNativeModule<SwaramEdgeNative>('SwaramEdge');
