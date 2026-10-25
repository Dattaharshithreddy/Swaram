/**
 * Long scripts on the phone: a job folder holds the script's parts as they
 * are generated (part-0000.f32, ...), so a crash, a closed app or a stop just
 * means "resume": finished parts are skipped. When every part is done they
 * are joined natively into one WAV. A foreground service with a progress
 * notification keeps generation going with the screen off.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { SwaramEdge } from '../../modules/swaram-edge';
import { SAMPLE_RATE } from './dsp';
import { type EdgeEngine, type EdgeVoiceData, writeFloats } from './engine';
import type { OfflineVoice } from './store';

export interface ScriptJob {
  id: string;
  title: string;
  voiceId: string;
  voiceName: string;
  language: string;
  steps: number;
  guidance: number;
  parts: string[];
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

function jobsDir(): Directory {
  const d = new Directory(Paths.document, 'edge-jobs');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

export function jobDir(id: string): Directory {
  return new Directory(jobsDir(), id);
}

function partFile(job: ScriptJob, i: number): File {
  return new File(jobDir(job.id), `part-${String(i).padStart(4, '0')}.f32`);
}

export function outputFile(job: ScriptJob): File {
  return new File(jobDir(job.id), 'swaram-script.wav');
}

function save(job: ScriptJob) {
  const f = new File(jobDir(job.id), 'job.json');
  f.writeSync(JSON.stringify(job));
}

export function listJobs(): ScriptJob[] {
  return jobsDir()
    .list()
    .filter((e): e is Directory => e instanceof Directory)
    .map((d) => {
      try {
        return JSON.parse(new File(d, 'job.json').textSync()) as ScriptJob;
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

export function deleteJob(job: ScriptJob) {
  const d = jobDir(job.id);
  if (d.exists) d.delete();
}

/** text must already be prepared (Telugu script, numbers spelled out). */
export function createJob(
  engine: EdgeEngine,
  voice: OfflineVoice,
  data: EdgeVoiceData,
  text: string,
  opts: { steps: number; guidance: number },
): ScriptJob {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const firstLine = text.trim().split(/\s+/).slice(0, 8).join(' ');
  const job: ScriptJob = {
    id,
    title: firstLine.length < text.trim().length ? `${firstLine}…` : firstLine,
    voiceId: voice.id,
    voiceName: voice.name,
    language: voice.language,
    steps: opts.steps,
    guidance: opts.guidance,
    parts: engine.chunks(data, text),
    createdAt: Date.now(),
    computeSeconds: 0,
    audioSeconds: 0,
  };
  jobDir(id).create({ intermediates: true, idempotent: true });
  save(job);
  return job;
}

/**
 * Generates the missing parts, then joins them. Returns true when the job
 * finished, false when stopped (it can be resumed later).
 */
export async function runJob(
  job: ScriptJob,
  engine: EdgeEngine,
  data: EdgeVoiceData,
  onProgress: (p: JobProgress) => void,
  shouldStop: () => boolean,
): Promise<boolean> {
  const edge = SwaramEdge;
  if (!edge) throw new Error('This app build has no offline engine.');
  const total = job.parts.length;
  const title = `Swaram: ${job.voiceName}`;
  let done = partsDone(job);
  const progress = { done: done * job.steps, total: total * job.steps };
  const report = () => onProgress({ partsDone: done, partsTotal: total, stepsDone: progress.done, stepsTotal: progress.total });
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
    const refMel = engine.refMelFile(data);
    const timing = engine.newTiming(job.steps);
    for (let i = 0; i < total; i++) {
      if (partFile(job, i).exists) continue;
      if (shouldStop()) return false;
      edge.updateBackground(title, `Part ${i + 1} of ${total}`, done, total);
      const t0 = Date.now();
      progress.done = i * job.steps;
      const wav = await engine.speakChunk(
        data,
        job.parts[i],
        { steps: job.steps, cfg: 2.0, sway: -1.0, guidance: job.guidance, speed: 1.0 },
        timing,
        progress,
        refMel,
      );
      // Write under a temporary name first, so a crash never leaves a half part.
      const tmp = new File(jobDir(job.id), `part-${i}.tmp`);
      if (tmp.exists) tmp.delete();
      writeFloats(tmp, wav);
      tmp.move(partFile(job, i));
      done++;
      job.computeSeconds += (Date.now() - t0) / 1000;
      job.audioSeconds += wav.length / SAMPLE_RATE;
      save(job);
      report();
    }
    edge.updateBackground(title, 'Joining the parts…', total, total);
    const out = outputFile(job);
    if (out.exists) out.delete();
    const parts = job.parts.map((_, i) => partFile(job, i).uri);
    await edge.joinWav(parts, out.uri, Math.floor(0.15 * SAMPLE_RATE));
    job.finishedAt = Date.now();
    save(job);
    return true;
  } finally {
    sub.remove();
    edge.stopBackground();
  }
}
