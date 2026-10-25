/**
 * Studio-quality rendering on Kaggle's free GPU: the app sends a project's
 * lines and voice recordings to a private notebook (cloud/swaram_render.ipynb),
 * which makes every big-model line with the full IndicF5 at 32 steps. When it
 * finishes, the app downloads the lines into the project; ⚡ fast voices and
 * sound clips are still made on the phone, then everything is joined as usual.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { SwaramEdge } from '../../modules/swaram-edge';
import { EMOTION_STYLE } from './emotions';
import { bytesToBase64, type KaggleAuth, pushNotebook, runOutputs, runStatus } from './kaggle';
import type { Credentials } from './kaggleTraining';
import { jobDir, partFile, saveJob, type ScriptJob } from './jobs';
import { emotionRecording, recordingFile } from './store';
import { findVoice } from './voices';

const TEMPLATE_URL = 'https://raw.githubusercontent.com/Dattaharshithreddy/Swaram/main/cloud/swaram_render.ipynb';

export interface Render {
  id: string;
  slug: string;
  username: string;
  url?: string;
  jobId: string;
  jobTitle: string;
  parts: number[];
  startedAt: number;
  state: 'running' | 'done' | 'failed';
  detail?: string;
}

function file() {
  return new File(Paths.document, 'swaram-renders.json');
}

export function listRenders(): Render[] {
  try {
    const f = file();
    return f.exists ? (JSON.parse(f.textSync()) as Render[]) : [];
  } catch {
    return [];
  }
}

function saveAll(all: Render[]) {
  file().writeSync(JSON.stringify(all.slice(0, 30)));
}

function update(r: Render) {
  saveAll(listRenders().map((x) => (x.id === r.id ? r : x)));
}

export function forgetRender(r: Render) {
  saveAll(listRenders().filter((x) => x.id !== r.id));
}

export function renderFor(jobId: string): Render | undefined {
  return listRenders().find((r) => r.jobId === jobId && r.state !== 'done');
}

/** The lines Kaggle can make: big-model speech (⚡ fast voices and sound clips stay on the phone). */
export function cloudParts(job: ScriptJob): number[] {
  return job.parts.flatMap((p, i) => (!p.sound && p.voice.startsWith('f5:') ? [i] : []));
}

export async function startRender(job: ScriptJob, creds: Credentials, trained?: (voiceKey: string) => { slug: string; file: string } | undefined): Promise<Render> {
  if (!creds.username || !creds.token || !creds.hfToken) {
    throw new Error('Add your Kaggle username, Kaggle API token and Hugging Face token in Settings first.');
  }
  const indices = cloudParts(job);
  if (!indices.length) throw new Error('This project has no big-model lines to render (⚡ fast voices are already instant).');
  const res = await fetch(`${TEMPLATE_URL}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`Could not get the render notebook (HTTP ${res.status}).`);
  const nb = await res.json();

  const voices: Record<string, { text: string; wav_base64: string; ckpt_name?: string }> = {};
  const sources: string[] = [];
  const parts: { i: number; voice: string; text: string; speed: number }[] = [];
  for (const i of indices) {
    const p = job.parts[i];
    const ref = findVoice(p.voice);
    if (!ref || ref.kind !== 'f5') throw new Error(`A voice in "${job.title}" was deleted. Pick another voice for its lines.`);
    const take = p.emotion && ref.voice.emotions?.[p.emotion] && emotionRecording(ref.voice, p.emotion).exists ? p.emotion : null;
    const key = take ? `${p.voice}|${take}` : p.voice;
    if (!voices[key]) {
      const wav = take ? emotionRecording(ref.voice, take) : recordingFile(ref.voice);
      if (!wav.exists) throw new Error(`"${ref.voice.name}" has no saved recording. Make the voice again to render it on Kaggle.`);
      const text = take ? (ref.voice.emotions?.[take]?.text ?? '') : ref.voice.text;
      voices[key] = { text: text.trim(), wav_base64: bytesToBase64(await wav.bytes()) };
      const t = trained?.(p.voice);
      if (t && !take) {
        voices[key].ckpt_name = t.file;
        if (!sources.includes(t.slug)) sources.push(t.slug);
      }
    }
    const style = p.emotion && !take ? EMOTION_STYLE[p.emotion] : null;
    parts.push({ i, voice: key, text: p.text, speed: job.speed * (style?.speed ?? 1) });
  }

  const appCell = [
    '# Sent by the Swaram app',
    'import os',
    `os.environ["HF_TOKEN"] = ${JSON.stringify(creds.hfToken.trim())}`,
    `APP_RENDER = ${JSON.stringify({ steps: 32, cfg: 2.0, voices, parts })}`,
  ].join('\n');
  nb.cells.splice(1, 0, { cell_type: 'code', metadata: {}, source: appCell, outputs: [], execution_count: null });

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const slug = `swaram-render-${id}`;
  const auth: KaggleAuth = { username: creds.username, token: creds.token };
  const pushed = await pushNotebook(auth, slug, nb, { gpu: true, internet: true, timeoutSeconds: 3 * 3600, kernelSources: sources });
  const r: Render = {
    id,
    slug,
    username: creds.username.trim(),
    url: pushed.url || `https://www.kaggle.com/code/${creds.username.trim()}/${slug}`,
    jobId: job.id,
    jobTitle: job.title,
    parts: indices,
    startedAt: Date.now(),
    state: 'running',
    detail: 'Starting on Kaggle…',
  };
  saveAll([r, ...listRenders().filter((x) => x.jobId !== job.id || x.state === 'done')]);
  return r;
}

/** Checks a render; when Kaggle is done, puts its lines into the project. Returns the new state. */
export async function checkRender(r: Render, creds: Credentials, job: ScriptJob | undefined): Promise<Render> {
  if (r.state !== 'running') return r;
  const auth: KaggleAuth = { username: creds.username || r.username, token: creds.token };
  const s = await runStatus(auth, r.slug);
  const next: Render = { ...r };
  if (s.state === 'complete') {
    if (!job) {
      next.state = 'failed';
      next.detail = 'The project was deleted.';
    } else {
      const out = await runOutputs(auth, r.slug);
      const pack = out.files.find((f) => f.fileName.endsWith('swaram-render.zip'));
      if (!pack || !SwaramEdge) {
        next.state = 'failed';
        next.detail = 'Kaggle finished but made no audio. Open the notebook on Kaggle to see what happened.';
      } else {
        const zip = new File(Paths.cache, `render-${r.id}.zip`);
        if (zip.exists) zip.delete();
        await File.downloadFileAsync(pack.url, zip);
        const dir = new Directory(Paths.cache, `render-${r.id}`);
        if (dir.exists) dir.delete();
        dir.create({ intermediates: true, idempotent: true });
        await SwaramEdge.unzip(zip.uri, dir.uri);
        let got = 0;
        for (const i of r.parts) {
          const wav = new File(dir, `part-${String(i).padStart(5, '0')}.wav`);
          if (!wav.exists) continue;
          const tmp = new File(jobDir(job.id), `part-${i}.tmp`);
          if (tmp.exists) tmp.delete();
          await SwaramEdge.decodeAudio(wav.uri, tmp.uri, 600);
          const dest = partFile(job, i);
          if (dest.exists) dest.delete();
          tmp.move(dest);
          got++;
        }
        zip.delete();
        dir.delete();
        // Re-join with the new lines.
        job.finishedAt = undefined;
        saveJob(job);
        next.state = got ? 'done' : 'failed';
        next.detail = got ? `${got} lines made at studio quality` : 'Kaggle made no lines. Open the notebook on Kaggle to see the log.';
      }
    }
  } else if (s.state === 'error' || s.state === 'cancelled') {
    next.state = 'failed';
    next.detail = s.message || (s.state === 'cancelled' ? 'The run was cancelled on Kaggle.' : 'The render failed on Kaggle. Open it there to see the log.');
  } else {
    const min = Math.round((Date.now() - r.startedAt) / 60000);
    next.detail = s.state === 'queued' ? 'Waiting for a free GPU on Kaggle…' : `Rendering on Kaggle · ${min} min so far (usually 10-20)`;
  }
  update(next);
  return next;
}
