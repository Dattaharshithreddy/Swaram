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
  listJobs,
  type MakeOptions,
  outputFile,
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
import { loadVoiceData, modelDir, modelInstalled, saveAudio } from './edge/store';
import { prepareText } from './edge/telugu';
import { displayName, keyOf, listAllVoices, type VoiceRef } from './edge/voices';
import { spokenText } from './translit';

export type Tab = 'home' | 'studio' | 'voices' | 'settings';
export type Page = { name: 'newVoice' } | { name: 'server' } | null;

/** Big-model guidance per quality preset (share of steps with guidance). */
export const QUALITY = [
  { steps: 8, guidance: 0.5, label: 'Fast' },
  { steps: 16, guidance: 0.6, label: 'Balanced' },
  { steps: 32, guidance: 1.0, label: 'Best' },
];
export const SPEEDS = [0.85, 1, 1.15];

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
    if (engine.current && engineProvider.current === provider) return engine.current;
    await engine.current?.release();
    engine.current = null;
    setEngineLoading(true);
    try {
      engine.current = await EdgeEngine.load(modelDir(), provider);
      engineProvider.current = provider;
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
      return async (key: string) => {
        const hit = cache.get(key);
        if (hit) return hit;
        const ref = listAllVoices().find((r) => keyOf(r) === key);
        if (!ref) throw new Error('A voice in this script was deleted. Pick another voice for its lines.');
        let maker: PartMaker;
        if (ref.kind === 'fast') {
          maker = fastMaker(await getFast(ref.voice), opts.speed);
        } else {
          if (!modelInstalled()) throw new Error('Download the offline model in Settings to use big-model voices.');
          const eng = await getEngine();
          maker = f5Maker(eng, await loadVoiceData(ref.voice), opts, `cond-${ref.voice.id}`);
        }
        cache.set(key, maker);
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
      const opts = { steps: p.steps, guidance: guidanceFor(p.steps), speed: p.speed };
      const prepared = prepare(text.trim(), ref.voice.language);
      const parts = ref.kind === 'fast' ? chunkText(prepared, 400) : chunksFor(ref.voice, prepared);
      const maker = await makerFor(opts)(keyOf(ref));
      const perPart = ref.kind === 'fast' ? 1 : opts.steps;
      const progress = { done: 0, total: parts.length * perPart };
      const sub = onProgress && SwaramEdge ? SwaramEdge.addListener('onProgress', (e) => onProgress(e.done, e.total)) : null;
      try {
        const pieces: Float32Array[] = [];
        for (let i = 0; i < parts.length; i++) {
          progress.done = i * perPart;
          pieces.push(await maker(parts[i], progress));
          onProgress?.((i + 1) * perPart, progress.total);
        }
        const wav = ref.kind === 'fast' ? crossFade(pieces, 0.05) : crossFade(pieces);
        const file = saveAudio(encodeWav(wav));
        const item = addRecent({
          uri: file.uri,
          title: text.trim().split(/\s+/).slice(0, 10).join(' '),
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
            uri: outputFile(job).uri,
            title: job.title,
            voiceName: Object.values(job.voiceNames).join(', '),
            seconds: job.audioSeconds,
            srtUri: srtFile(job).uri,
          });
          setRecent(listRecent());
        }
      } catch (e) {
        setJobError(`${e instanceof Error ? e.message : String(e)} Finished parts are saved: tap Resume to continue.`);
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
