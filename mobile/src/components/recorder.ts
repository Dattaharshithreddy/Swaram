import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { resample, SAMPLE_RATE } from '../edge/dsp';

/** Records mono 24 kHz float audio with live levels; stops by itself after maxSeconds. */
export function useRecorder(maxSeconds = 15) {
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [clip, setClip] = useState<Float32Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const buffers = useRef<Float32Array[]>([]);
  const rate = useRef(SAMPLE_RATE);
  const channels = useRef(1);
  const samples = useRef(0);
  const { stream, isStreaming } = useAudioStream({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: 'float32',
    onBuffer: (b) => {
      const data = new Float32Array(b.data.slice(0));
      buffers.current.push(data);
      rate.current = b.sampleRate;
      channels.current = b.channels;
      samples.current += data.length / Math.max(1, b.channels);
      let m = 0;
      for (let i = 0; i < data.length; i += 8) m = Math.max(m, Math.abs(data[i]));
      setLevels((prev) => [...prev.slice(-43), Math.min(1, m * 2.5)]);
      setSeconds(samples.current / b.sampleRate);
    },
  });

  async function stop() {
    stream.stop();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const total = buffers.current.reduce((s, b) => s + b.length, 0);
    const interleaved = new Float32Array(total);
    let o = 0;
    for (const b of buffers.current) {
      interleaved.set(b, o);
      o += b.length;
    }
    const ch = Math.max(1, channels.current);
    const mono = new Float32Array(Math.floor(total / ch));
    for (let i = 0; i < mono.length; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += interleaved[i * ch + c];
      mono[i] = s / ch;
    }
    setClip(resample(mono, rate.current, SAMPLE_RATE));
  }

  useEffect(() => {
    if (isStreaming && seconds >= maxSeconds) void stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, seconds]);

  async function start() {
    setError(null);
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setError('Microphone permission is off. Allow it in your phone settings to record.');
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    buffers.current = [];
    samples.current = 0;
    setSeconds(0);
    setLevels([]);
    setClip(null);
    await stream.start();
  }

  function reset() {
    if (isStreaming) stream.stop();
    setClip(null);
    setSeconds(0);
    setLevels([]);
  }

  return { start, stop, reset, isStreaming, seconds, levels, clip, setClip, error };
}

/** Peak shape of a clip for the level bars. */
export function clipShape(clip: Float32Array, n = 44): number[] {
  const step = Math.max(1, Math.floor(clip.length / n));
  const out: number[] = [];
  let peak = 1e-6;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = i * step; j < Math.min(clip.length, (i + 1) * step); j += 16) m = Math.max(m, Math.abs(clip[j]));
    out.push(m);
    peak = Math.max(peak, m);
  }
  return out.map((m) => m / peak);
}
