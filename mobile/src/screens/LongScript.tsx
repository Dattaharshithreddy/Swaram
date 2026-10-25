import * as DocumentPicker from 'expo-document-picker';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Body, Button, Card, Field, Label, Notice } from '../components/ui';
import type { EdgeEngine } from '../edge/engine';
import { type FastVoice, listPersonal, type PersonalVoice } from '../edge/personal';
import {
  createFastJob,
  createJob,
  deleteJob,
  f5Maker,
  fastMaker,
  type JobProgress,
  listJobs,
  outputFile,
  partsDone,
  runJob,
  type ScriptJob,
} from '../edge/jobs';
import { listVoices, loadVoiceData, type OfflineVoice } from '../edge/store';
import { prepareText } from '../edge/telugu';
import { radius, space, useTheme } from '../theme';
import { downloadAudio } from '../download';
import { spokenText } from '../translit';

// The running job lives outside the component, so leaving the tab and coming
// back shows it still going.
type Running = { jobId: string; progress: JobProgress | null; stop: boolean };
let running: Running | null = null;
const listeners = new Set<() => void>();
/** True while a long script is generating (the engine must stay loaded). */
export function jobRunning(): boolean {
  return running !== null;
}
function notify() {
  for (const l of listeners) l();
}

function useRunning() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return running;
}

function minutes(sec: number) {
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

export type ScriptVoice = { kind: 'f5'; voice: OfflineVoice } | { kind: 'fast'; voice: PersonalVoice };

export function LongScript({
  getEngine,
  getFast,
  target,
  steps,
  guidance,
}: {
  getEngine: () => Promise<EdgeEngine>;
  getFast: (v: PersonalVoice) => Promise<FastVoice>;
  target: ScriptVoice | undefined;
  steps: number;
  guidance: number;
}) {
  const voice = target?.voice;
  const t = useTheme();
  const run = useRunning();
  const [script, setScript] = useState('');
  const [jobs, setJobs] = useState<ScriptJob[]>(() => listJobs());
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const player = useAudioPlayer(null);

  const refresh = () => setJobs(listJobs());
  useEffect(() => {
    if (!run) refresh();
  }, [run]);

  async function loadFile() {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({ type: ['text/plain', 'text/*'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    try {
      setScript(await new File(res.assets[0].uri).text());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function execute(job: ScriptJob) {
    if (running) return;
    const fastVoice = job.kind === 'fast' ? listPersonal().find((x) => x.id === job.voiceId) : undefined;
    const v = job.kind === 'fast' ? undefined : listVoices().find((x) => x.id === job.voiceId);
    if (!fastVoice && !v) {
      setError(`The voice "${job.voiceName}" was deleted, so this script can't continue.`);
      return;
    }
    running = { jobId: job.id, progress: null, stop: false };
    notify();
    setError(null);
    try {
      const maker = fastVoice
        ? fastMaker(await getFast(fastVoice))
        : f5Maker(await getEngine(), await loadVoiceData(v as OfflineVoice), job);
      await runJob(
        job,
        maker,
        (p) => {
          if (running) running.progress = p;
          notify();
        },
        () => running?.stop === true,
      );
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)} Finished parts are saved: tap Resume to continue.`);
    } finally {
      running = null;
      notify();
      refresh();
    }
  }

  async function start() {
    if (!target || !script.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const text = prepareText(spokenText(script.trim(), target.voice.language), target.voice.language);
      const job =
        target.kind === 'fast'
          ? createFastJob(await getFast(target.voice), target.voice, text)
          : createJob(await getEngine(), target.voice, await loadVoiceData(target.voice), text, { steps, guidance });
      setScript('');
      refresh();
      setStarting(false);
      await execute(job);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  async function play(job: ScriptJob) {
    await setAudioModeAsync({ playsInSilentMode: true });
    player.replace({ uri: outputFile(job).uri });
    player.play();
  }

  const words = script.trim() ? script.trim().split(/\s+/).length : 0;

  return (
    <Card>
      <Label>Long script</Label>
      <Body muted>
        Paste a whole script or load a .txt file. It is made part by part and saved as it goes: it keeps working with the
        screen off, and if the app closes, tap Resume to continue from the last finished part.
      </Body>
      <Field
        label={voice ? `Script for ${voice.name}` : 'Script'}
        value={script}
        onChangeText={setScript}
        multiline
        placeholder="Paste your script here"
        style={{ minHeight: 140, maxHeight: 320, textAlignVertical: 'top', fontSize: 16, lineHeight: 24 }}
      />
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Notice text={words ? `${words} words · about ${Math.max(1, Math.round(words / 130))} min of audio` : ' '} />
        <Text style={{ color: t.accent, fontWeight: '600' }} onPress={loadFile}>
          Load .txt file
        </Text>
      </View>
      <Button
        title="Make the whole script"
        onPress={start}
        busy={starting}
        disabled={!voice || !script.trim() || run !== null}
      />
      {error && <Notice text={error} kind="error" />}

      {jobs.length > 0 && <Label>Your scripts</Label>}
      {jobs.map((job) => {
        const isRunning = run?.jobId === job.id;
        const done = isRunning && run?.progress ? run.progress.partsDone : partsDone(job);
        const finished = job.finishedAt !== undefined && outputFile(job).exists;
        const perPart = done > 0 ? job.computeSeconds / Math.max(1, partsDone(job)) : 0;
        const left = perPart ? perPart * (job.parts.length - done) : 0;
        const stepFrac = isRunning && run?.progress ? run.progress.stepsDone / Math.max(1, run.progress.stepsTotal) : done / job.parts.length;
        return (
          <View key={job.id} style={{ borderWidth: 1, borderColor: t.line, borderRadius: radius.md, padding: space.md, gap: space.sm }}>
            <Text style={{ color: t.ink, fontWeight: '700', fontSize: 15 }} numberOfLines={2}>
              {job.title}
            </Text>
            <Text style={{ color: t.soft, fontSize: 13 }}>
              {job.voiceName} · {finished ? `${minutes(job.audioSeconds)} of audio, made in ${minutes(job.computeSeconds)}` : `${done} of ${job.parts.length} parts`}
              {!finished && left ? ` · about ${minutes(left)} left` : ''}
            </Text>
            {!finished && (
              <View style={{ height: 6, borderRadius: radius.pill, backgroundColor: t.line, overflow: 'hidden' }}>
                <View style={{ height: 6, width: `${Math.round(stepFrac * 100)}%`, backgroundColor: t.accent }} />
              </View>
            )}
            <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
              {finished ? (
                <>
                  <Button title="Play" kind="secondary" onPress={() => play(job)} />
                  <Button title="Download" kind="secondary" onPress={() => downloadAudio(outputFile(job).uri, `${job.voiceName}-script`)} />
                  <Button title="Share" kind="secondary" onPress={() => Sharing.shareAsync(outputFile(job).uri, { mimeType: 'audio/wav' })} />
                </>
              ) : isRunning ? (
                <Button
                  title={run?.stop ? 'Stopping after this part…' : 'Stop'}
                  kind="secondary"
                  onPress={() => {
                    if (running) running.stop = true;
                    notify();
                  }}
                />
              ) : (
                <Button title="Resume" onPress={() => execute(job)} disabled={run !== null} />
              )}
              {!isRunning && (
                <Button
                  title="Delete"
                  kind="danger"
                  onPress={() => {
                    deleteJob(job);
                    refresh();
                  }}
                />
              )}
            </View>
          </View>
        );
      })}
    </Card>
  );
}
