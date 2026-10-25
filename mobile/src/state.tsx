/**
 * Shared app state for the offline studio: voices, the loaded engines,
 * preferences, recent audio, the running script and Kaggle trainings.
 * Screens read it with useApp().
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { SwaramEdge } from '../modules/swaram-edge';
import { crossFade, encodeWav, SAMPLE_RATE } from './edge/dsp';
import { chunkText, chunksFor, EdgeEngine } from './edge/engine';
import {
  f5Maker,
  fastMaker,
  type JobProgress,
  withGain,
  listJobs,
  type MakeOptions,
  finalAudio,
  srtFile,
  type MakerFor,
  type PartMaker,
  runJob,
  type ScriptJob,
} from './edge/jobs';
import {
  checkTraining,
  type Credentials,
  listTrainings,
  loadCredentials,
  type Training,
} from './edge/kaggleTraining';
import { FastVoice, type PersonalVoice } from './edge/personal';
import { applyPronunciations, getPrefs, type Prefs, setPrefs } from './edge/prefs';
import { addRecent, listRecent, type RecentItem } from './edge/recent';
import { loadEmotionData, loadVoiceData, modelDir, modelInstalled, refreshVoice, saveAudio, studioInstalled } from './edge/store';
import { type Emotion, EMOTION_STYLE } from './edge/emotions';
import { parseScript } from './edge/script';
import { prepareText } from './edge/telugu';
import { displayName, keyOf, listAllVoices, type VoiceRef } from './edge/voices';
import { spokenText } from './translit';
import { friendlyError } from './errors';

export type Tab = 'home' | 'studio' | 'voices' | 'settings';
export type Page = { name: 'newVoice' } | { name: 'server' } | { name: 'emotion'; voiceId: string } | null;

/** Big-model guidance per quality preset (share of steps with guidance). */
export const QUALITY = [
  { steps: 8, guidance: 0.5, label: 'Fast' },
  { steps: 16, guidance: 0.6, label: 'Balanced' },
  { steps: 32, guidance: 1.0, label: 'Best' },
];
export const SPEEDS = [0.85, 1, 1.15];

/** The steps to use: Studio quality always runs the full 32 steps. */
export function effectiveSteps(p: { steps: number; studio?: boolean }): number {
  return p.studio && studioInstalled() ? 32 : p.steps;
}

export function guidanceFor(steps: number) {
  return QUALITY.find((q) => q.steps === steps)?.guidance ?? 1;
}

interface Running {
  job: ScriptJob;
  progress: JobProgress | null;
  stop: boolean;
}

interface AppState {
  tab: Tab;
  setTab: (t: Tab) => void;
  page: Page;
  setPage: (p: Page) => void;

  installed: boolean;
  refreshModel: () => void;
  voices: VoiceRef[];
  refreshVoices: () => void;
  prefs: Prefs;
  updatePrefs: (p: Partial<Prefs>) => void;

  engineLoading: boolean;
  getEngine: () => Promise<EdgeEngine>;
  releaseEngine: () => Promise<void>;
  makerFor: (opts: MakeOptions) => MakerFor;
  prepare: (text: string, language: string) => string;
  speakQuick: (ref: VoiceRef, text: string, onProgress?: (done: number, total: number) => void) => Promise<RecentItem>;

  recent: RecentItem[];
  refreshRecent: () => void;

  jobs: ScriptJob[];
  refreshJobs: () => void;
  running: Running | null;
  startJob: (job: ScriptJob) => Promise<void>;
  stopJob: () => void;
  jobError: string | null;

  creds: Credentials | null;
  setCreds: (c: Credentials) => void;
  trainings: Training[];
  refreshTrainings: () => void;
  checkTrainings: () => Promise<void>;
  checkingTrainings: boolean;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

export function AppProvider({ children, initialTab = 'home' }: { children: ReactNode; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [page, setPage] = useState<Page>(null);
  const [installed, setInstalled] = useState(() => modelInstalled());
  const [voices, setVoices] = useState<VoiceRef[]>(() => listAllVoices());
  const [prefs, setPrefsState] = useState<Prefs>(() => getPrefs());
  const [engineLoading, setEngineLoading] = useState(false);
  const [recent, setRecent] = useState<RecentItem[]>(() => listRecent());
  const [jobs, setJobs] = useState<ScriptJob[]>(() => listJobs());
  const [running, setRunning] = useState<Running | null>(null);
  const runningRef = useRef<Running | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [creds, setCredsState] = useState<Credentials | null>(null);
  const [trainings, setTrainings] = useState<Training[]>(() => listTrainings());
  const [checkingTrainings, setChecking] = useState(false);

  const engine = useRef<EdgeEngine | null>(null);
  const engineProvider = useRef<string | null>(null);
  const fastCache = useRef(new Map<string, FastVoice>());

  const refreshModel = useCallback(() => setInstalled(modelInstalled()), []);
  const refreshVoices = useCallback(() => setVoices(listAllVoices()), []);
  const refreshRecent = useCallback(() => setRecent(listRecent()), []);
  const refreshJobs = useCallback(() => setJobs(listJobs()), []);
  const refreshTrainings = useCallback(() => setTrainings(listTrainings()), []);

  const updatePrefs = useCallback((p: Partial<Prefs>) => setPrefsState(setPrefs(p)), []);

  const getEngine = useCallback(async () => {
    const provider = getPrefs().provider;
    const studio = getPrefs().studio && studioInstalled();
    const want = `${provider}${studio ? '+studio' : ''}`;
    if (engine.current && engineProvider.current === want) return engine.current;
    await engine.current?.release();
    engine.current = null;
    setEngineLoading(true);
    try {
      engine.current = await EdgeEngine.load(modelDir(), provider, 4, studio);
      engineProvider.current = want;
      return engine.current;
    } finally {
      setEngineLoading(false);
    }
  }, []);

  const releaseEngine = useCallback(async () => {
    await engine.current?.release();
    engine.current = null;
  }, []);

  const getFast = useCallback(async (v: PersonalVoice) => {
    const hit = fastCache.current.get(v.id);
    if (hit) return hit;
    const fv = await FastVoice.load(v);
    fastCache.current.set(v.id, fv);
    return fv;
  }, []);

  const makerFor = useCallback(
    (opts: MakeOptions): MakerFor => {
      const cache = new Map<string, PartMaker>();
      return async (key: string, emotion?: Emotion | null, speedMul = 1) => {
        const cacheKey = `${key}|${emotion ?? ''}|${speedMul.toFixed(2)}`;
        const hit = cache.get(cacheKey);
        if (hit) return hit;
        const ref = listAllVoices().find((r) => keyOf(r) === key);
        if (!ref) throw new Error('A voice in this script was deleted. Pick another voice for its lines.');
        // A line with an emotion uses the voice's recording in that tone; without one,
        // speed and loudness are adjusted instead (EMOTION_STYLE).
        const style = emotion ? EMOTION_STYLE[emotion] : null;
        const base = { ...opts, speed: opts.speed * speedMul };
        let maker: PartMaker;
        if (ref.kind === 'fast') {
          const fv = await getFast(ref.voice);
          maker = fv.knows(emotion)
            ? fastMaker(fv, base.speed, emotion)
            : withGain(fastMaker(fv, base.speed * (style?.speed ?? 1)), style?.gain ?? 1);
        } else {
          if (!modelInstalled()) throw new Error('Download the offline model in Settings to use big-model voices.');
          const eng = await getEngine();
          const voice = await refreshVoice(ref.voice, (clip, text) => eng.makeVoice(clip, text));
          if (voice !== ref.voice) {
            ref.voice = voice;
            setVoices(listAllVoices());
          }
          const take = emotion ? await loadEmotionData(ref.voice, emotion) : null;
          maker = take
            ? f5Maker(eng, take, base, `cond-${ref.voice.id}-${emotion}`)
            : withGain(
                f5Maker(eng, await loadVoiceData(ref.voice), { ...base, speed: base.speed * (style?.speed ?? 1) }, `cond-${ref.voice.id}`),
                style?.gain ?? 1,
              );
        }
        cache.set(cacheKey, maker);
        return maker;
      };
    },
    [getEngine, getFast],
  );

  const prepare = useCallback(
    (text: string, language: string) => prepareText(spokenText(applyPronunciations(text), language), language),
    [],
  );

  const speakQuick = useCallback(
    async (ref: VoiceRef, text: string, onProgress?: (done: number, total: number) => void) => {
      const p = getPrefs();
      const steps = effectiveSteps(p);
      const opts = { steps, guidance: guidanceFor(steps), speed: p.speed };
      // Quick speak understands the same [happy] / [pause 2s] tags as Studio (one voice).
      const pieces: { text: string; emotion: Emotion | null; pause: number }[] = [];
      for (const seg of parseScript(text)) {
        const prepared = prepare(seg.text, ref.voice.language);
        const chunks = (ref.kind === 'fast' ? chunkText(prepared, 400) : chunksFor(ref.voice, prepared)).filter((c) => c.trim());
        chunks.forEach((c, i) =>
          pieces.push({ text: c, emotion: seg.emotion, pause: i === chunks.length - 1 ? seg.pauseAfter * (seg.emotion ? EMOTION_STYLE[seg.emotion].pause : 1) : 0 }),
        );
      }
      if (!pieces.length) throw new Error('Type something to speak.');
      const makers = makerFor(opts);
      const perPart = ref.kind === 'fast' ? 1 : opts.steps;
      const progress = { done: 0, total: pieces.length * perPart };
      const sub = onProgress && SwaramEdge ? SwaramEdge.addListener('onProgress', (e) => onProgress(e.done, e.total)) : null;
      try {
        const audio: Float32Array[] = [];
        for (let i = 0; i < pieces.length; i++) {
          progress.done = i * perPart;
          const maker = await makers(keyOf(ref), pieces[i].emotion);
          audio.push(await maker(pieces[i].text, progress));
          if (pieces[i].pause > 0) audio.push(new Float32Array(Math.round(pieces[i].pause * SAMPLE_RATE)));
          onProgress?.((i + 1) * perPart, progress.total);
        }
        const wav = ref.kind === 'fast' ? crossFade(audio, 0.05) : crossFade(audio);
        const file = saveAudio(encodeWav(wav));
        if (getPrefs().polish && SwaramEdge) await SwaramEdge.polish(file.uri, file.uri);
        const item = addRecent({
          uri: file.uri,
          title: text.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/).slice(0, 10).join(' '),
          voiceName: displayName(ref),
          seconds: wav.length / SAMPLE_RATE,
        });
        setRecent(listRecent());
        return item;
      } finally {
        sub?.remove();
      }
    },
    [makerFor, prepare],
  );

  const startJob = useCallback(
    async (job: ScriptJob) => {
      if (runningRef.current) return;
      const r: Running = { job, progress: null, stop: false };
      runningRef.current = r;
      setRunning({ ...r });
      setJobError(null);
      try {
        const finished = await runJob(
          job,
          makerFor({ steps: job.steps, guidance: job.guidance, speed: job.speed }),
          (p) => {
            if (runningRef.current) {
              runningRef.current.progress = p;
              setRunning({ ...runningRef.current });
            }
          },
          () => runningRef.current?.stop === true,
        );
        if (finished) {
          addRecent({
            uri: finalAudio(job).uri,
            title: job.title,
            voiceName: Object.values(job.voiceNames).join(', '),
            seconds: job.audioSeconds,
            srtUri: srtFile(job).uri,
          });
          setRecent(listRecent());
        }
      } catch (e) {
        setJobError(`${friendlyError(e)} Finished parts are saved: tap Resume to continue.`);
      } finally {
        runningRef.current = null;
        setRunning(null);
        setJobs(listJobs());
      }
    },
    [makerFor],
  );

  const stopJob = useCallback(() => {
    if (runningRef.current) {
      runningRef.current.stop = true;
      setRunning({ ...runningRef.current });
    }
  }, []);

  useEffect(() => {
    void loadCredentials().then(setCredsState);
  }, []);

  const checkTrainings = useCallback(async () => {
    const c = creds ?? (await loadCredentials());
    if (!c.token) return;
    setChecking(true);
    let imported = false;
    try {
      for (const tr of listTrainings().filter((x) => x.state === 'running')) {
        try {
          const next = await checkTraining(tr, c);
          if (next.state === 'done') imported = true;
        } catch {
          // Shown on the next check; network may be down.
        }
      }
    } finally {
      setTrainings(listTrainings());
      setChecking(false);
      if (imported) setVoices(listAllVoices());
    }
  }, [creds]);

  // Check running trainings once keys are known (app open).
  useEffect(() => {
    if (creds?.token && listTrainings().some((t) => t.state === 'running')) void checkTrainings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds?.token]);

  const value = useMemo<AppState>(
    () => ({
      tab,
      setTab,
      page,
      setPage,
      installed,
      refreshModel,
      voices,
      refreshVoices,
      prefs,
      updatePrefs,
      engineLoading,
      getEngine,
      releaseEngine,
      makerFor,
      prepare,
      speakQuick,
      recent,
      refreshRecent,
      jobs,
      refreshJobs,
      running,
      startJob,
      stopJob,
      jobError,
      creds,
      setCreds: setCredsState,
      trainings,
      refreshTrainings,
      checkTrainings,
      checkingTrainings,
    }),
    [tab, page, installed, refreshModel, voices, refreshVoices, prefs, updatePrefs, engineLoading, getEngine, releaseEngine, makerFor, prepare, speakQuick, recent, refreshRecent, jobs, refreshJobs, running, startJob, stopJob, jobError, creds, trainings, refreshTrainings, checkTrainings, checkingTrainings],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
