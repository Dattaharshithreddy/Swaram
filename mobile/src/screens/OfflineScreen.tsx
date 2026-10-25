import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioStream,
} from 'expo-audio';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, Chip, Field, Label, Notice, Title } from '../components/ui';
import { encodeWav, resample, SAMPLE_RATE } from '../edge/dsp';
import { SwaramEdge } from '../../modules/swaram-edge';
import { EdgeEngine, type Provider, type Timing } from '../edge/engine';
import { prepareText } from '../edge/telugu';
import {
  deleteModel,
  deleteVoice,
  exportForTraining,
  hasRecording,
  downloadModel,
  installedBytes,
  listVoices,
  loadVoiceData,
  modelDir,
  modelInstalled,
  modelNeedsUpdate,
  type OfflineVoice,
  saveAudio,
  saveVoice,
} from '../edge/store';
import { LANGUAGES, type LanguageCode, languageByCode } from '../languages';
import { radius, space, useTheme } from '../theme';
import { ReadAs } from '../components/ReadAs';
import { downloadAudio } from '../download';
import { KaggleTrain } from './KaggleTrain';
import { UploadClip } from './UploadClip';
import { jobRunning, LongScript, type ScriptVoice } from './LongScript';
import * as DocumentPicker from 'expo-document-picker';
import { deletePersonal, FastVoice, importPersonal, listPersonal, type PersonalVoice } from '../edge/personal';
import { spokenText } from '../translit';

const INDIC = LANGUAGES.filter((l) => l.code !== 'en');
// guidance: share of steps (from the start) that use guidance; the rest cost half.
const QUALITY = [
  { steps: 8, guidance: 0.5, label: 'Fast · 8' },
  { steps: 16, guidance: 0.6, label: 'Balanced · 16' },
  { steps: 32, guidance: 1.0, label: 'Best · 32' },
];
// Offline voices use a shorter reading: every second of the reference is
// processed again on each step, so 5 s instead of 8 s is about a third faster.
const OFFLINE_READ: Record<string, string> = {
  te: 'నమస్కారం, ఈ రోజు వాతావరణం చాలా బాగుంది. నేను బయటికి వెళ్తున్నాను.',
};
const PROVIDERS: { key: Provider; label: string }[] = [
  { key: 'xnnpack', label: 'CPU (XNNPACK)' },
  { key: 'cpu', label: 'CPU (basic)' },
  { key: 'nnapi', label: 'AI chip (NNAPI)' },
];

function mb(bytes: number) {
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

export function OfflineScreen() {
  const t = useTheme();
  const [installed, setInstalled] = useState(modelInstalled());
  const [download, setDownload] = useState<{ bytes: number; total: number; file: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crash] = useState<string | null>(() => {
    try {
      return SwaramEdge?.crashReport() ?? null;
    } catch {
      return null;
    }
  });
  const [provider, setProvider] = useState<Provider>('xnnpack');
  const [steps, setSteps] = useState(8);
  const [engineState, setEngineState] = useState<'idle' | 'loading' | 'ready'>('idle');
  const engine = useRef<EdgeEngine | null>(null);
  const engineProvider = useRef<Provider | null>(null);
  const cancelDownload = useRef({ cancelled: false });

  const [voices, setVoices] = useState<OfflineVoice[]>(() => listVoices());
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [fastVoices, setFastVoices] = useState<PersonalVoice[]>(() => listPersonal());
  const [fastId, setFastId] = useState<string | null>(null);
  const fastEngine = useRef<FastVoice | null>(null);
  const [fastResult, setFastResult] = useState<{ uri: string; audio: number; wall: number } | null>(null);
  const [creating, setCreating] = useState(false);

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ uri: string; timing: Timing; wall: number } | null>(null);
  const stopRef = useRef(false);

  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);

  const fastVoice = fastId ? fastVoices.find((v) => v.id === fastId) : undefined;
  const voice = fastVoice ? undefined : (voices.find((v) => v.id === voiceId) ?? voices[0]);
  const fastSelected = fastVoice ?? (voices.length === 0 ? fastVoices[0] : undefined);
  const target: ScriptVoice | undefined = fastSelected
    ? { kind: 'fast', voice: fastSelected }
    : voice
      ? { kind: 'f5', voice }
      : undefined;
  const lang = languageByCode(target?.voice.language);

  const getFast = useCallback(async (v: PersonalVoice) => {
    if (fastEngine.current?.voice.id === v.id) return fastEngine.current;
    fastEngine.current = await FastVoice.load(v);
    return fastEngine.current;
  }, []);

  async function importFast() {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({ type: ['application/zip', 'application/octet-stream', '*/*'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    try {
      const v = await importPersonal(res.assets[0].uri);
      setFastVoices(listPersonal());
      setFastId(v.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function exportVoice(v: OfflineVoice) {
    setError(null);
    try {
      const uri = await exportForTraining(v);
      await Sharing.shareAsync(uri, { mimeType: 'application/zip', dialogTitle: 'Save or upload for Kaggle' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function generateFast(v: PersonalVoice) {
    setBusy(true);
    setError(null);
    setFastResult(null);
    try {
      const fast = await getFast(v);
      const { wav, seconds } = await fast.speak(
        prepareText(spokenText(text.trim(), v.language), v.language),
        (done, total) => setProgress({ done, total }),
      );
      const file = saveAudio(encodeWav(wav));
      setFastResult({ uri: file.uri, audio: wav.length / SAMPLE_RATE, wall: seconds });
      await setAudioModeAsync({ playsInSilentMode: true });
      player.replace({ uri: file.uri });
      player.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // Free the model's memory when leaving the tab, unless a long script is still generating.
  useEffect(
    () => () => {
      if (!jobRunning()) void engine.current?.release();
    },
    [],
  );

  const getEngine = useCallback(async () => {
    if (engine.current && engineProvider.current === provider) return engine.current;
    await engine.current?.release();
    engine.current = null;
    setEngineState('loading');
    try {
      engine.current = await EdgeEngine.load(modelDir(), provider);
      engineProvider.current = provider;
      setEngineState('ready');
      return engine.current;
    } catch (e) {
      setEngineState('idle');
      throw e;
    }
  }, [provider]);

  async function startDownload() {
    setError(null);
    cancelDownload.current = { cancelled: false };
    setDownload({ bytes: 0, total: 0, file: '' });
    try {
      await downloadModel((bytes, total, file) => setDownload({ bytes, total, file }), cancelDownload.current);
      setInstalled(modelInstalled());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownload(null);
    }
  }

  async function removeModel() {
    await engine.current?.release();
    engine.current = null;
    setEngineState('idle');
    deleteModel();
    setInstalled(false);
  }

  async function generate() {
    if (!text.trim()) return;
    if (fastSelected) return generateFast(fastSelected);
    if (!voice) return;
    setBusy(true);
    setError(null);
    setResult(null);
    stopRef.current = false;
    const t0 = Date.now();
    try {
      const eng = await getEngine();
      const data = await loadVoiceData(voice);
      const { wav, timing } = await eng.speak(data, prepareText(spokenText(text.trim(), voice.language), voice.language), {
        steps,
        guidance: QUALITY.find((q) => q.steps === steps)?.guidance ?? 1,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      const file = saveAudio(encodeWav(wav));
      setResult({ uri: file.uri, timing, wall: (Date.now() - t0) / 1000 });
      await setAudioModeAsync({ playsInSilentMode: true });
      player.replace({ uri: file.uri });
      player.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  if (creating) {
    return (
      <NewOfflineVoice
        getEngine={getEngine}
        onCancel={() => setCreating(false)}
        onDone={(v) => {
          setVoices(listVoices());
          setVoiceId(v.id);
          setCreating(false);
        }}
      />
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Title>Offline (beta)</Title>
      <Body muted>
        Clones and speaks entirely on this phone. No server and no internet after a one-time download. Speed
        depends on your phone; the numbers below tell you exactly how fast it is.
      </Body>

      {crash && (
        <Card>
          <Label>The app closed last time. Send a screenshot of this report:</Label>
          <Text selectable style={{ fontFamily: 'monospace', fontSize: 11, color: t.ink }}>
            {crash}
          </Text>
        </Card>
      )}

      <Card>
        <Label>Model</Label>
        {installed ? (
          <>
            <Notice text={`Installed · ${mb(installedBytes())}`} kind="ok" />
            <Button title="Delete model" kind="secondary" onPress={removeModel} disabled={busy} />
          </>
        ) : download ? (
          <>
            <Body>Downloading {download.file}…</Body>
            <View style={[styles.bar, { backgroundColor: t.line }]}>
              <View
                style={[
                  styles.barFill,
                  { backgroundColor: t.accent, width: `${download.total ? (100 * download.bytes) / download.total : 0}%` },
                ]}
              />
            </View>
            <Notice text={download.total ? `${mb(download.bytes)} of ${mb(download.total)}` : 'Starting…'} />
            <Button title="Cancel" kind="secondary" onPress={() => (cancelDownload.current.cancelled = true)} />
          </>
        ) : (
          <>
            <Body>
              {modelNeedsUpdate()
                ? 'A faster version of the model is available. Update downloads about 350 MB; your voices are kept.'
                : 'One-time download of about 450 MB. Use Wi-Fi.'}
            </Body>
            <Button title="Download offline model" onPress={startDownload} />
          </>
        )}
      </Card>

      {(installed || fastVoices.length > 0) && (
        <>
          {installed && (
          <Card>
            <Label>Speed settings</Label>
            <Body muted>Fewer steps are faster but rougher. Try Fast first to see your phone's speed.</Body>
            <View style={styles.wrap}>
              {QUALITY.map((q) => (
                <Chip key={q.steps} label={q.label} selected={steps === q.steps} onPress={() => setSteps(q.steps)} />
              ))}
            </View>
            <View style={styles.wrap}>
              {PROVIDERS.map((p) => (
                <Chip key={p.key} label={p.label} selected={provider === p.key} onPress={() => setProvider(p.key)} />
              ))}
            </View>
            {engineState === 'loading' && <Notice text="Loading the model into memory…" />}
          </Card>
          )}

          <Card>
            <Label>Offline voices</Label>
            {voices.length === 0 && fastVoices.length === 0 ? (
              <Body muted>No offline voices yet.</Body>
            ) : (
              <View style={styles.wrap}>
                {voices.map((v) => (
                  <Chip
                    key={v.id}
                    label={v.name}
                    selected={!fastSelected && v.id === voice?.id}
                    onPress={() => {
                      setFastId(null);
                      setVoiceId(v.id);
                    }}
                  />
                ))}
                {fastVoices.map((v) => (
                  <Chip key={v.id} label={`⚡ ${v.name}`} selected={fastSelected?.id === v.id} onPress={() => setFastId(v.id)} />
                ))}
              </View>
            )}
            {fastSelected && <Notice text="⚡ Personal fast voice: a sentence takes about a second." kind="ok" />}
            <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
              {installed && <Button title="+ New offline voice" onPress={() => setCreating(true)} style={{ flex: 1 }} />}
              {target && (
                <Button
                  title="Delete"
                  kind="secondary"
                  onPress={() => {
                    if (target.kind === 'fast') {
                      deletePersonal(target.voice);
                      setFastVoices(listPersonal());
                      setFastId(null);
                    } else {
                      deleteVoice(target.voice);
                      setVoices(listVoices());
                      setVoiceId(null);
                    }
                  }}
                />
              )}
            </View>
            <Button title="Import personal voice (.zip)" kind="secondary" onPress={importFast} />
            {voice && !fastSelected && hasRecording(voice) && (
              <Text style={{ color: t.accent, fontWeight: '600' }} onPress={() => exportVoice(voice)}>
                Export recording for training by hand (Kaggle notebook)
              </Text>
            )}
          </Card>

          {installed && voices.length > 0 && (
            <KaggleTrain voice={fastSelected ? undefined : voice} onImported={() => setFastVoices(listPersonal())} />
          )}

          {target && (
            <Card>
              <Field
                label={`Text${lang ? ` in ${lang.name}` : ''}`}
                value={text}
                onChangeText={setText}
                multiline
                placeholder={lang?.example || 'Type in the voice’s language'}
                style={{ minHeight: 110, textAlignVertical: 'top', fontSize: 17, lineHeight: 26 }}
              />
              {lang?.example ? (
                <Text style={{ color: t.accent, fontWeight: '600' }} onPress={() => setText(lang.example)}>
                  Use example
                </Text>
              ) : null}
              <ReadAs text={text} language={target.voice.language} onUse={setText} />
              {busy ? (
                <>
                  <View style={[styles.bar, { backgroundColor: t.line }]}>
                    <View
                      style={[
                        styles.barFill,
                        {
                          backgroundColor: t.accent,
                          width: `${progress ? (100 * progress.done) / progress.total : 0}%`,
                        },
                      ]}
                    />
                  </View>
                  <Notice
                    text={
                      engineState === 'loading'
                        ? 'Loading the model…'
                        : progress
                          ? fastSelected
                            ? `Part ${progress.done} of ${progress.total}`
                            : `Step ${progress.done} of ${progress.total}`
                          : 'Preparing…'
                    }
                  />
                </>
              ) : (
                <Button title="Generate on this phone" onPress={generate} disabled={!text.trim()} />
              )}
              {!fastSelected && result && <SpeedReport result={result} />}
              {fastSelected && fastResult && (
                <View style={[styles.report, { backgroundColor: t.tint }]}>
                  <Text style={{ color: t.ink, fontWeight: '800', fontSize: 16 }}>
                    {fastResult.audio.toFixed(1)} s of audio in {fastResult.wall.toFixed(1)} s
                  </Text>
                  <Text style={{ color: t.ok }}>
                    {(fastResult.audio / Math.max(fastResult.wall, 1e-3)).toFixed(1)}× faster than real time
                  </Text>
                </View>
              )}
              {(fastSelected ? fastResult : result) && (
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Button
                    title={status.playing ? 'Pause' : 'Play'}
                    kind="secondary"
                    style={{ flex: 1 }}
                    onPress={() => {
                      if (status.playing) player.pause();
                      else {
                        if (status.duration > 0 && status.currentTime >= status.duration - 0.05) void player.seekTo(0);
                        player.play();
                      }
                    }}
                  />
                  <Button
                    title="Download"
                    kind="secondary"
                    style={{ flex: 1 }}
                    onPress={() => {
                      const uri = fastSelected ? fastResult?.uri : result?.uri;
                      if (uri) void downloadAudio(uri, target?.voice.name);
                    }}
                  />
                  <Button
                    title="Share"
                    kind="secondary"
                    style={{ flex: 1 }}
                    onPress={() => {
                      const uri = fastSelected ? fastResult?.uri : result?.uri;
                      if (uri) void Sharing.shareAsync(uri, { dialogTitle: 'Share audio' });
                    }}
                  />
                </View>
              )}
            </Card>
          )}
          {target && (
            <LongScript
              getEngine={getEngine}
              getFast={getFast}
              target={target}
              steps={steps}
              guidance={QUALITY.find((q) => q.steps === steps)?.guidance ?? 1}
            />
          )}
        </>
      )}
      {error && <Notice text={error} kind="error" />}
    </ScrollView>
  );
}

function SpeedReport({ result }: { result: { timing: Timing; wall: number } }) {
  const t = useTheme();
  const { timing, wall } = result;
  const rtf = wall / Math.max(timing.audioSeconds, 1e-3);
  const fast = rtf <= 1;
  return (
    <View style={[styles.report, { backgroundColor: t.tint }]}>
      <Text style={{ color: t.ink, fontWeight: '800', fontSize: 16 }}>
        {timing.audioSeconds.toFixed(1)} s of audio in {wall.toFixed(1)} s
      </Text>
      <Text style={{ color: fast ? t.ok : t.ink }}>
        {fast ? `${(1 / rtf).toFixed(1)}× faster than real time` : `${rtf.toFixed(1)}× slower than real time`}
      </Text>
      <Text style={{ color: t.soft, fontSize: 12 }}>
        {timing.steps} steps · per step {((1000 * timing.stepSeconds) / Math.max(1, timing.steps)).toFixed(0)} ms ·
        vocoder {timing.vocoderSeconds.toFixed(1)} s · model load {timing.loadSeconds.toFixed(1)} s
      </Text>
    </View>
  );
}

function NewOfflineVoice({
  getEngine,
  onDone,
  onCancel,
}: {
  getEngine: () => Promise<EdgeEngine>;
  onDone: (v: OfflineVoice) => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<LanguageCode>('te');
  const lang = languageByCode(language);
  const [transcript, setTranscript] = useState(OFFLINE_READ[language] ?? lang?.readAloud ?? '');
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<Float32Array | null>(null);
  const [source, setSource] = useState<'mic' | 'file'>('mic');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
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
      setSeconds(samples.current / b.sampleRate);
    },
  });

  useEffect(() => {
    if (isStreaming && seconds >= 15) void stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, seconds]);

  useEffect(() => {
    if (source === 'mic') setTranscript(OFFLINE_READ[language] ?? languageByCode(language)?.readAloud ?? '');
  }, [language, source]);

  function chooseSource(next: 'mic' | 'file') {
    if (next === source) return;
    if (isStreaming) stream.stop();
    setClip(null);
    setSeconds(0);
    if (next === 'file') setTranscript('');
    setSource(next);
  }

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
    setClip(null);
    await stream.start();
  }

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

  async function create() {
    if (!clip) return;
    setBusy(true);
    setError(null);
    try {
      const eng = await getEngine();
      const data = await eng.makeVoice(clip, spokenText(transcript, language));
      onDone(saveVoice(name.trim(), language, data, clip));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const clipSeconds = clip ? clip.length / SAMPLE_RATE : seconds;
  const lengthOk = clipSeconds >= 4 && clipSeconds <= 10;

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title>New offline voice</Title>
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>
      <Card>
        <Field label="Voice name" value={name} onChangeText={setName} placeholder="e.g. Amma" maxLength={60} />
        <Label>Language</Label>
        <View style={styles.wrap}>
          {INDIC.map((l) => (
            <Chip key={l.code} label={`${l.native} · ${l.name}`} selected={language === l.code} onPress={() => setLanguage(l.code)} />
          ))}
        </View>
      </Card>
      <Card>
        <View style={styles.wrap}>
          <Chip label="Record now" selected={source === 'mic'} onPress={() => chooseSource('mic')} />
          <Chip label="Upload a recording" selected={source === 'file'} onPress={() => chooseSource('file')} />
        </View>
        {source === 'mic' ? (
          <>
            <Label>Record 4-8 seconds</Label>
            <Body muted>Read this aloud exactly, in a quiet room:</Body>
            <Field
              label="What you will read (edit if you say something else)"
              value={transcript}
              onChangeText={setTranscript}
              multiline
              style={{ minHeight: 80, textAlignVertical: 'top', fontSize: 17, lineHeight: 26 }}
            />
            <Pressable
              accessibilityRole="button"
              onPress={isStreaming ? stop : start}
              style={[styles.mic, { backgroundColor: isStreaming ? t.danger : t.accent }]}
            >
              <Text style={{ color: t.onAccent, fontSize: 17, fontWeight: '800' }}>
                {isStreaming ? `Stop · ${seconds.toFixed(1)} s` : clip ? 'Record again' : 'Record'}
              </Text>
            </Pressable>
            {clip && (
              <Notice
                text={`${clipSeconds.toFixed(1)} s recorded${lengthOk ? ': good length.' : ': aim for 4-8 seconds.'}`}
                kind={lengthOk ? 'ok' : 'error'}
              />
            )}
          </>
        ) : (
          <>
            <UploadClip onClip={setClip} />
            <Field
              label="Exactly what is said in this part"
              value={transcript}
              onChangeText={setTranscript}
              multiline
              placeholder="Type every word you hear, in Telugu script or English letters"
              style={{ minHeight: 80, textAlignVertical: 'top', fontSize: 17, lineHeight: 26 }}
            />
            {language === 'te' && transcript.trim() !== '' && (
              <ReadAs text={transcript} language={language} onUse={setTranscript} />
            )}
          </>
        )}
      </Card>
      <Card>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: consent }}
          onPress={() => setConsent(!consent)}
          style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}
        >
          <View style={[styles.box, { borderColor: t.accent, backgroundColor: consent ? t.accent : 'transparent' }]}>
            {consent && <Text style={{ color: t.onAccent, fontWeight: '900' }}>✓</Text>}
          </View>
          <Text style={{ color: t.ink, flex: 1, fontSize: 15, lineHeight: 21 }}>
            This is my own voice, or the speaker has given me written permission to clone it.
          </Text>
        </Pressable>
        <Button
          title="Create offline voice"
          onPress={create}
          busy={busy}
          disabled={!clip || !name.trim() || !transcript.trim() || !consent || isStreaming}
        />
        <Notice text="The voice is saved only on this phone." />
        {error && <Notice text={error} kind="error" />}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  bar: { height: 8, borderRadius: radius.pill, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: radius.pill },
  report: { borderRadius: radius.md, padding: space.md, gap: 2 },
  mic: { minHeight: 64, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
