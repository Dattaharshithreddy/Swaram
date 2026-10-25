/** Small audio helpers for the offline engine (no native code needed). */

export const SAMPLE_RATE = 24000;

/** Linear resampling; good enough for a speech reference clip. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const outLen = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float32Array(outLen);
  const ratio = from / to;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

export function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length) + 1e-12);
}

/** Drop leading/trailing silence (20 ms frames below -42 dBFS), keep 50 ms. */
export function trimSilence(wav: Float32Array, thresholdDb = -42, keepMs = 50): Float32Array {
  const frame = Math.floor(0.02 * SAMPLE_RATE);
  const n = Math.floor(wav.length / frame);
  if (n < 3) return wav;
  let first = -1;
  let last = -1;
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) s += wav[i] * wav[i];
    const db = 20 * Math.log10(Math.sqrt(s / frame + 1e-12));
    if (db > thresholdDb) {
      if (first < 0) first = f;
      last = f;
    }
  }
  if (first < 0) return wav;
  const keep = Math.floor((keepMs / 1000) * SAMPLE_RATE);
  return wav.subarray(Math.max(0, first * frame - keep), Math.min(wav.length, (last + 1) * frame + keep));
}

/**
 * Long pauses inside the reference (stopping between words while reading) are
 * copied by the model as odd gaps and slow, stretched speech, so each pause is
 * cut down to at most maxPauseMs.
 */
export function shortenPauses(wav: Float32Array, maxPauseMs = 250): Float32Array {
  const frame = Math.floor(0.02 * SAMPLE_RATE);
  const n = Math.floor(wav.length / frame);
  if (n < 5) return wav;
  const db: number[] = [];
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) s += wav[i] * wav[i];
    db.push(20 * Math.log10(Math.sqrt(s / frame + 1e-12)));
  }
  const loud = [...db].sort((a, b) => b - a)[Math.floor(n * 0.1)];
  const threshold = Math.max(-45, loud - 30);
  const maxFrames = Math.max(1, Math.round(maxPauseMs / 20));
  const keep: [number, number][] = [];
  let f = 0;
  while (f < n) {
    if (db[f] >= threshold) {
      const start = f;
      while (f < n && db[f] >= threshold) f++;
      keep.push([start * frame, f * frame]);
    } else {
      const start = f;
      while (f < n && db[f] < threshold) f++;
      const len = f - start;
      const kept = Math.min(len, maxFrames);
      // Keep the middle of the pause so word endings and breaths stay intact.
      const from = start + Math.floor((len - kept) / 2);
      keep.push([from * frame, (from + kept) * frame]);
    }
  }
  keep.push([n * frame, wav.length]);
  const total = keep.reduce((a, [x, y]) => a + (y - x), 0);
  if (total >= wav.length) return wav;
  const out = new Float32Array(total);
  let o = 0;
  for (const [x, y] of keep) {
    out.set(wav.subarray(x, y), o);
    o += y - x;
  }
  return out;
}

export function crossFade(pieces: Float32Array[], seconds = 0.15): Float32Array {
  if (pieces.length === 0) return new Float32Array(0);
  let out = pieces[0];
  const n = Math.floor(seconds * SAMPLE_RATE);
  for (const next of pieces.slice(1)) {
    const k = Math.min(n, out.length, next.length);
    const merged = new Float32Array(out.length + next.length - k);
    merged.set(out.subarray(0, out.length - k), 0);
    for (let i = 0; i < k; i++) {
      const a = i / Math.max(1, k - 1);
      merged[out.length - k + i] = out[out.length - k + i] * (1 - a) + next[i] * a;
    }
    merged.set(next.subarray(k), out.length);
    out = merged;
  }
  return out;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/** Standard normal noise (Box-Muller). */
export function gaussian(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.max(Math.random(), 1e-12);
    const v = Math.random();
    const r = Math.sqrt(-2 * Math.log(u));
    out[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  return out;
}

export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}
