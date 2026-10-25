/**
 * Scripts on the phone (one voice or many): a job folder holds each part's
 * audio as it is generated (part-0000.f32, ...), so a crash, a closed app or
 * Stop just means "resume": finished parts are skipped. Any single part can
 * be made again ("redo this line"). When every part is done they are joined
 * natively into one WAV with the script's pauses, and subtitles (.srt) are
 * written from the same timings. A foreground service with a progress
 * notification keeps generation going with the screen off.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { getPrefs } from './prefs';
import { SwaramEdge } from '../../modules/swaram-edge';
import { SAMPLE_RATE } from './dsp';
import { chunkText, chunksFor, type EdgeEngine, type EdgeVoiceData, writeFloats } from './engine';
import type { FastVoice } from './personal';
import { type Emotion, EMOTION_STYLE } from './emotions';
import { parseScript } from './script';
import { soundFile, soundSlug } from './sounds';
import { parseSrt } from './srt';
import { displayName, findVoice, keyOf, listAllVoices, type VoiceRef } from './voices';

/** Makes one part's audio (24 kHz); progress.done/total count steps for the bar. */
export type PartMaker = (text: string, progress: { done: number; total: number }) => Promise<Float32Array>;
/**
 * Gives the maker for a voice key and emotion (loads the model, voice or
 * emotion recording as needed). speedMul > 1 speaks faster (dubbing uses it
 * to fit a line into its subtitle's time).
 */
export type MakerFor = (voiceKey: string, emotion?: Emotion | null, speedMul?: number) => Promise<PartMaker>;

export interface MakeOptions {
  steps: number;
  guidance: number;
  speed: number;
}

export function f5Maker(engine: EdgeEngine, data: EdgeVoiceData, opts: MakeOptions, refName = 'cond'): PartMaker {
  const refMel = engine.refMelFile(data, refName);
  const timing = engine.newTiming(opts.steps);
  return (text, progress) =>
    engine.speakChunk(data, text, { steps: opts.steps, cfg: 2.0, sway: -1.0, guidance: opts.guidance, speed: opts.speed }, timing, progress, refMel);
}

export function fastMaker(fast: FastVoice, speed = 1, emotion?: Emotion | null): PartMaker {
  return (text) => fast.speakPart(text, speed, emotion);
}

/** Louder or softer, with a soft limit so loud styles don't clip harshly. */
export function withGain(maker: PartMaker, gain: number): PartMaker {
  if (Math.abs(gain - 1) < 0.01) return maker;
  return async (text, progress) => {
    const x = await maker(text, progress);
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v = x[i] * gain;
      out[i] = v > 0.9 ? 0.9 + Math.tanh((v - 0.9) * 5) * 0.09 : v < -0.9 ? -0.9 - Math.tanh((-v - 0.9) * 5) * 0.09 : v;
    }
    return out;
  };
}

export interface JobPart {
  text: string;
  voice: string;
  speaker: string | null;
  emotion?: Emotion | null;
  /** A sound clip (Studio > Sounds) instead of speech. */
  sound?: string;
  /** Dubbing: when this line starts (s) and how long it may take. */
  startAt?: number;
  slot?: number;
  /** Silence after this part, seconds. */
  pauseAfter: number;
}

export interface ScriptJob {
  id: string;
  version: 2;
  /** 'dub': lines timed to subtitles. */
  kind?: 'script' | 'dub';
  title: string;
  /** Background music mixed under the finished audio. */
  music?: { name: string; gain: number; duck: boolean; uri?: string };
  parts: JobPart[];
  /** voice key -> display name, as it was when the job was made. */
  voiceNames: Record<string, string>;
  steps: number;
  guidance: number;
  speed: number;
  createdAt: number;
  computeSeconds: number;
  audioSeconds: number;
  finishedAt?: number;
}

export interface JobProgress {
  partsDone: number;
  partsTotal: number;
  stepsDone: number;
  stepsTotal: number;
}

const FADE_SECONDS = 0.15;

function jobsDir(): Directory {
  const d = new Directory(Paths.document, 'edge-jobs');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

export function jobDir(id: string): Directory {
  return new Directory(jobsDir(), id);
}

export function partFile(job: ScriptJob, i: number): File {
  return new File(jobDir(job.id), `part-${String(i).padStart(4, '0')}.f32`);
}

export function outputFile(job: ScriptJob): File {
  return new File(jobDir(job.id), 'swaram-script.wav');
}

export function musicFile(job: ScriptJob): File {
  return new File(jobDir(job.id), 'swaram-script-music.wav');
}

/** The finished audio to play and share: with music when it has some. */
export function finalAudio(job: ScriptJob): File {
  const m = musicFile(job);
  return job.music && m.exists ? m : outputFile(job);
}

export function srtFile(job: ScriptJob): File {
  return new File(jobDir(job.id), 'swaram-script.srt');
}

function save(job: ScriptJob) {
  new File(jobDir(job.id), 'job.json').writeSync(JSON.stringify(job));
}

/** Jobs from earlier app versions had one voice and plain-text parts. */
function upgrade(raw: Record<string, unknown>): ScriptJob {
  if (raw.version === 2) return raw as unknown as ScriptJob;
  const kind = raw.kind === 'fast' ? 'fast' : 'f5';
  const key = `${kind}:${String(raw.voiceId)}`;
  return {
    id: String(raw.id),
    version: 2,
    title: String(raw.title ?? 'Script'),
    parts: ((raw.parts as string[]) ?? []).map((text) => ({ text, voice: key, speaker: null, pauseAfter: 0 })),
    voiceNames: { [key]: `${kind === 'fast' ? '⚡ ' : ''}${String(raw.voiceName ?? 'Voice')}` },
    steps: Number(raw.steps ?? 8),
    guidance: Number(raw.guidance ?? 1),
    speed: 1,
    createdAt: Number(raw.createdAt ?? Date.now()),
    computeSeconds: Number(raw.computeSeconds ?? 0),
    audioSeconds: Number(raw.audioSeconds ?? 0),
    finishedAt: raw.finishedAt as number | undefined,
  };
}

export function listJobs(): ScriptJob[] {
  return jobsDir()
    .list()
    .filter((e): e is Directory => e instanceof Directory)
    .map((d) => {
      try {
        return upgrade(JSON.parse(new File(d, 'job.json').textSync()));
      } catch {
        return null;
      }
    })
    .filter((j): j is ScriptJob => j !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function partsDone(job: ScriptJob): number {
  let n = 0;
  for (let i = 0; i < job.parts.length; i++) if (partFile(job, i).exists) n++;
  return n;
}

export function isFinished(job: ScriptJob): boolean {
  return job.finishedAt !== undefined && outputFile(job).exists;
}

export function deleteJob(job: ScriptJob) {
  const d = jobDir(job.id);
  if (d.exists) d.delete();
}

/** Voices this job uses, by key (for the "N voices" label). */
export function jobVoiceKeys(job: ScriptJob): string[] {
  return [...new Set(job.parts.filter((p) => !p.sound).map((p) => p.voice))];
}

function splitForVoice(ref: VoiceRef, text: string): string[] {
  return ref.kind === 'fast' ? chunkText(text, 400) : chunksFor(ref.voice, text);
}

/**
 * Builds a job from a script. voiceFor maps a speaker label (or null for
 * unlabelled lines) to a voice key; prepare turns text into what the model
 * reads (pronunciations, English letters to Telugu, numbers spelled out).
 */
export function createScriptJob(
  script: string,
  opts: MakeOptions & {
    title?: string;
    voiceFor: (speaker: string | null) => string | undefined;
    prepare: (text: string, language: string) => string;
  },
): ScriptJob {
  const all = listAllVoices();
  const parts: JobPart[] = [];
  const voiceNames: Record<string, string> = {};
  for (const seg of parseScript(script)) {
    if (seg.sound) {
      const f = soundFile(seg.sound);
      if (!f.exists) throw new Error(`Add the sound "${seg.sound}" first (Studio > Sound clips).`);
      parts.push({ text: '', voice: '', speaker: seg.speaker, sound: soundSlug(seg.sound), pauseAfter: seg.pauseAfter });
      continue;
    }
    const key = opts.voiceFor(seg.speaker);
    const ref = findVoice(key, all);
    if (!ref) throw new Error(seg.speaker ? `Choose a voice for "${seg.speaker}".` : 'Choose a voice.');
    voiceNames[keyOf(ref)] = displayName(ref);
    const pieces = splitForVoice(ref, opts.prepare(seg.text, ref.voice.language)).filter((p) => p.trim());
    const pause = seg.emotion ? seg.pauseAfter * EMOTION_STYLE[seg.emotion].pause : seg.pauseAfter;
    pieces.forEach((text, i) =>
      parts.push({
        text,
        voice: keyOf(ref),
        speaker: seg.speaker,
        emotion: seg.emotion,
        pauseAfter: i === pieces.length - 1 ? Math.round(pause * 100) / 100 : 0,
      }),
    );
  }
  if (!parts.some((p) => !p.sound)) throw new Error('The script is empty.');
  const firstWords = script.replace(/^[^:\n]{1,24}:\s*/, '').trim().split(/\s+/).slice(0, 7).join(' ');
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job: ScriptJob = {
    id,
    version: 2,
    title: opts.title?.trim() || `${firstWords}…`,
    parts,
    voiceNames,
    steps: opts.steps,
    guidance: opts.guidance,
    speed: opts.speed,
    createdAt: Date.now(),
    computeSeconds: 0,
    audioSeconds: 0,
  };
  jobDir(id).create({ intermediates: true, idempotent: true });
  save(job);
  return job;
}

/**
 * A dub from subtitles: each cue is spoken in its voice (cues may start with
 * "Name:" and carry emotion tags), starting at the cue's time; a line that
 * comes out too long is made again a little faster to fit.
 */
export function createDubJob(
  srt: string,
  opts: MakeOptions & {
    title?: string;
    voiceFor: (speaker: string | null) => string | undefined;
    prepare: (text: string, language: string) => string;
  },
): ScriptJob {
  const all = listAllVoices();
  const cues = parseSrt(srt);
  if (!cues.length) throw new Error('No subtitles found in this file. Use a .srt file.');
  const parts: JobPart[] = [];
  const voiceNames: Record<string, string> = {};
  cues.forEach((cue, i) => {
    const segs = parseScript(cue.text).filter((g) => !g.sound);
    if (!segs.length) return;
    const speaker = segs[0].speaker;
    const key = opts.voiceFor(speaker);
    const ref = findVoice(key, all);
    if (!ref) throw new Error(speaker ? `Choose a voice for "${speaker}".` : 'Choose a voice.');
    voiceNames[keyOf(ref)] = displayName(ref);
    const nextStart = cues[i + 1]?.start ?? cue.end + 2;
    parts.push({
      text: opts.prepare(segs.map((g) => g.text).join(' '), ref.voice.language),
      voice: keyOf(ref),
      speaker,
      emotion: segs[0].emotion,
      startAt: cue.start,
      slot: Math.max(0.5, nextStart - cue.start - 0.05),
      pauseAfter: 0,
    });
  });
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job: ScriptJob = {
    id,
    version: 2,
    kind: 'dub',
    title: opts.title?.trim() || `Dub · ${cues.length} lines`,
    parts,
    voiceNames,
    steps: opts.steps,
    guidance: opts.guidance,
    speed: opts.speed,
    createdAt: Date.now(),
    computeSeconds: 0,
    audioSeconds: 0,
  };
  jobDir(id).create({ intermediates: true, idempotent: true });
  save(job);
  return job;
}

function stepsFor(job: ScriptJob, part: JobPart): number {
  if (part.sound) return 1;
  return part.voice.startsWith('fast:') ? 1 : job.steps;
}

async function makePart(job: ScriptJob, i: number, makerFor: MakerFor, progress: { done: number; total: number }) {
  const part = job.parts[i];
  const dest = partFile(job, i);
  if (part.sound) {
    const src = soundFile(part.sound);
    if (!src.exists) throw new Error(`The sound "${part.sound}" was deleted. Add it again in Studio > Sound clips.`);
    if (dest.exists) dest.delete();
    src.copy(dest);
    return 0;
  }
  const maker = await makerFor(part.voice, part.emotion ?? null);
  const t0 = Date.now();
  let wav = await maker(part.text, progress);
  if (part.slot && wav.length > part.slot * SAMPLE_RATE * 1.05) {
    // Dubbing: too long for its subtitle, so make it again a little faster.
    const mul = Math.min(1.6, wav.length / (part.slot * SAMPLE_RATE));
    const faster = await makerFor(part.voice, part.emotion ?? null, mul);
    wav = await faster(part.text, progress);
  }
  // Write under a temporary name first, so a crash never leaves a half part.
  const tmp = new File(jobDir(job.id), `part-${i}.tmp`);
  if (tmp.exists) tmp.delete();
  writeFloats(tmp, wav);
  if (dest.exists) dest.delete();
  tmp.move(dest);
  job.computeSeconds += (Date.now() - t0) / 1000;
  return wav.length;
}

function silenceFile(job: ScriptJob, seconds: number): File {
  const f = new File(jobDir(job.id), `silence-${Math.round(seconds * 1000)}.f32`);
  if (!f.exists) writeFloats(f, new Float32Array(Math.round(seconds * SAMPLE_RATE) + Math.round(FADE_SECONDS * SAMPLE_RATE)));
  return f;
}

/** Joins the parts (with pauses) into the WAV and writes the subtitles. */
async function finish(job: ScriptJob) {
  const edge = SwaramEdge;
  if (!edge) throw new Error('This app build has no offline engine.');
  const files: string[] = [];
  const cues: { start: number; end: number; text: string; speaker: string | null }[] = [];
  const fade = FADE_SECONDS;
  let t = 0;
  let first = true;
  const place = (seconds: number) => {
    const start = first ? 0 : t - fade;
    t = start + seconds;
    first = false;
    return start;
  };
  job.parts.forEach((p, i) => {
    if (p.startAt !== undefined) {
      // Dubbing: wait until this line's subtitle time.
      const gap = p.startAt - (first ? 0 : t - fade);
      if (gap > 0.02) {
        const s = silenceFile(job, Math.round(gap * 1000) / 1000);
        files.push(s.uri);
        place((s.size ?? 0) / 4 / SAMPLE_RATE);
      }
    }
    const f = partFile(job, i);
    files.push(f.uri);
    const seconds = (f.size ?? 0) / 4 / SAMPLE_RATE;
    const start = place(seconds);
    if (!p.sound) cues.push({ start, end: start + seconds, text: p.text, speaker: p.speaker });
    if (p.pauseAfter > 0) {
      const s = silenceFile(job, p.pauseAfter);
      files.push(s.uri);
      place((s.size ?? 0) / 4 / SAMPLE_RATE);
    }
  });
  const out = outputFile(job);
  if (out.exists) out.delete();
  const samples = await edge.joinWav(files, out.uri, Math.floor(fade * SAMPLE_RATE));
  job.audioSeconds = samples / SAMPLE_RATE;
  if (getPrefs().polish) await edge.polish(out.uri, out.uri);
  const srt = srtFile(job);
  if (srt.exists) srt.delete();
  srt.writeSync(toSrt(cues));
  job.finishedAt = Date.now();
  save(job);
  if (job.music?.uri) await mix(job);
}

async function mix(job: ScriptJob) {
  const edge = SwaramEdge;
  if (!edge || !job.music) return;
  const out = musicFile(job);
  if (out.exists) out.delete();
  const music = new File(jobDir(job.id), 'music-source');
  await edge.mixMusic(outputFile(job).uri, music.uri, out.uri, job.music.gain, job.music.duck, 2);
}

/** Puts background music (any audio file) under a finished project. */
export async function addMusic(job: ScriptJob, uri: string, name: string, gain: number, duck = true) {
  const src = new File(jobDir(job.id), 'music-source');
  if (src.exists) src.delete();
  new File(uri).copy(src);
  job.music = { name, gain, duck, uri: src.uri };
  save(job);
  if (isFinished(job)) await mix(job);
}

export async function setMusicVolume(job: ScriptJob, gain: number) {
  if (!job.music) return;
  job.music = { ...job.music, gain };
  save(job);
  if (isFinished(job)) await mix(job);
}

export function removeMusic(job: ScriptJob) {
  job.music = undefined;
  const m = musicFile(job);
  if (m.exists) m.delete();
  save(job);
}

function stamp(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export function toSrt(cues: { start: number; end: number; text: string; speaker: string | null }[]): string {
  return `${cues
    .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.speaker ? `${c.speaker}: ` : ''}${c.text}`)
    .join('\n\n')}\n`;
}

/**
 * Generates the missing parts, then joins them. Returns true when the job
 * finished, false when stopped (it can be resumed later).
 */
export async function runJob(
  job: ScriptJob,
  makerFor: MakerFor,
  onProgress: (p: JobProgress) => void,
  shouldStop: () => boolean,
): Promise<boolean> {
  const edge = SwaramEdge;
  if (!edge) throw new Error('This app build has no offline engine.');
  const total = job.parts.length;
  const title = `Swaram: ${job.title}`;
  let done = partsDone(job);
  const stepsTotal = job.parts.reduce((s, p) => s + stepsFor(job, p), 0);
  const stepsBefore = (i: number) => job.parts.slice(0, i).reduce((s, p) => s + stepsFor(job, p), 0);
  const progress = { done: 0, total: stepsTotal };
  const report = () => onProgress({ partsDone: done, partsTotal: total, stepsDone: progress.done, stepsTotal });
  const sub = edge.addListener('onProgress', (e) => {
    progress.done = e.done;
    report();
  });
  try {
    edge.requestNotifications();
  } catch {
    // Notifications are optional.
  }
  edge.startBackground(title, `Part ${Math.min(done + 1, total)} of ${total}`);
  report();
  try {
    for (let i = 0; i < total; i++) {
      if (partFile(job, i).exists) continue;
      if (shouldStop()) return false;
      edge.updateBackground(title, `Part ${i + 1} of ${total}`, done, total);
      progress.done = stepsBefore(i);
      await makePart(job, i, makerFor, progress);
      progress.done = stepsBefore(i + 1);
      done++;
      save(job);
      report();
    }
    edge.updateBackground(title, 'Joining the parts…', total, total);
    await finish(job);
    return true;
  } finally {
    sub.remove();
    edge.stopBackground();
  }
}

/** Makes one part again (a line that came out wrong) and re-joins the finished audio. */
export async function redoPart(job: ScriptJob, i: number, makerFor: MakerFor, newText?: string): Promise<void> {
  if (newText !== undefined && newText.trim()) job.parts[i] = { ...job.parts[i], text: newText.trim() };
  const f = partFile(job, i);
  if (f.exists) f.delete();
  await makePart(job, i, makerFor, { done: 0, total: stepsFor(job, job.parts[i]) });
  save(job);
  if (partsDone(job) === job.parts.length) await finish(job);
}

/** Changes the emotion of one part (it must be made again). */
export function setPartEmotion(job: ScriptJob, i: number, emotion: Emotion | null) {
  job.parts[i] = { ...job.parts[i], emotion };
  const f = partFile(job, i);
  if (f.exists) f.delete();
  job.finishedAt = undefined;
  save(job);
}

/** Changes the voice of one part (it must be made again). */
export function setPartVoice(job: ScriptJob, i: number, ref: VoiceRef) {
  job.parts[i] = { ...job.parts[i], voice: keyOf(ref) };
  job.voiceNames[keyOf(ref)] = displayName(ref);
  const f = partFile(job, i);
  if (f.exists) f.delete();
  job.finishedAt = undefined;
  save(job);
}
