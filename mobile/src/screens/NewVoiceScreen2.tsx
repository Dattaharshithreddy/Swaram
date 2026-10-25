import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { CleanNoise } from '../components/CleanNoise';
import { usePlayer } from '../components/player';
import { ReadAs } from '../components/ReadAs';
import { Body, Button, Card, Chip, Field, Header, Icon, Label, Notice, Screen, Segmented } from '../components/ui';
import { encodeWav, resample, SAMPLE_RATE } from '../edge/dsp';
import { saveVoice } from '../edge/store';
import { LANGUAGES, type LanguageCode, languageByCode } from '../languages';
import { useApp } from '../state';
import { font, radius, space, useTheme } from '../theme';
import { spokenText } from '../translit';
import { UploadClip } from './UploadClip';

const INDIC = LANGUAGES.filter((l) => l.code !== 'en');
// A short reading: every second of the reference is processed again for each line spoken.
const OFFLINE_READ: Record<string, string> = {
  te: 'నమస్కారం, ఈ రోజు వాతావరణం చాలా బాగుంది. నేను బయటికి వెళ్తున్నాను.',
};

/** Live level bars while recording, then the clip's shape. */
function Bars({ levels, color }: { levels: number[]; color: string }) {
  const t = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 56, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      {levels.map((l, i) => (
        <View key={i} style={{ width: 4, borderRadius: 2, height: Math.max(4, Math.min(56, l * 56)), backgroundColor: l > 0 ? color : t.lineStrong }} />
      ))}
    </View>
  );
}

function shape(clip: Float32Array, n = 44): number[] {
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

export function NewVoiceScreen2() {
  const t = useTheme();
  const app = useApp();
  const player = usePlayer();
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<LanguageCode>('te');
  const lang = languageByCode(language);
  const [source, setSource] = useState<'mic' | 'file'>('mic');
  const [transcript, setTranscript] = useState(OFFLINE_READ.te);
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState<Float32Array | null>(null);
  const [clipUri, setClipUri] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
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
      let m = 0;
      for (let i = 0; i < data.length; i += 8) m = Math.max(m, Math.abs(data[i]));
      setLevels((prev) => [...prev.slice(-43), Math.min(1, m * 2.5)]);
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

  useEffect(() => {
    if (!clip) {
      setClipUri(null);
      return;
    }
    const f = new File(Paths.cache, `swaram-recording-${Date.now()}.wav`);
    f.writeSync(encodeWav(clip));
    setClipUri(f.uri);
  }, [clip]);

  function chooseSource(next: 'mic' | 'file') {
    if (next === source) return;
    if (isStreaming) stream.stop();
    setClip(null);
    setSeconds(0);
    setLevels([]);
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
    player.stop();
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    buffers.current = [];
    samples.current = 0;
    setSeconds(0);
    setLevels([]);
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
      if (!app.installed) throw new Error('Download the offline model in Settings first: it is needed to make a voice.');
      const eng = await app.getEngine();
      const data = await eng.makeVoice(clip, spokenText(transcript, language));
      saveVoice(name.trim(), language, data, clip);
      app.refreshVoices();
      app.setPage(null);
      app.setTab('voices');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const clipSeconds = clip ? clip.length / SAMPLE_RATE : seconds;
  const lengthOk = clipSeconds >= 4 && clipSeconds <= 10;
  const playing = clipUri ? player.isPlaying(clipUri) : false;

  return (
    <Screen>
      <Header title="New voice" onBack={() => app.setPage(null)} />
      {!app.installed && <Notice text="The offline model isn't downloaded yet. Download it in Settings (about 450 MB) before creating a voice." kind="error" />}
      <Card>
        <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Amma" maxLength={40} hint="In multi-voice scripts, write this name before a line to use this voice." />
        <Label>Language</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {INDIC.map((l) => (
            <Chip key={l.code} label={`${l.native} · ${l.name}`} selected={language === l.code} onPress={() => setLanguage(l.code)} />
          ))}
        </View>
      </Card>

      <Segmented
        options={[
          { key: 'mic', label: 'Record now' },
          { key: 'file', label: 'Upload a recording' },
        ]}
        value={source}
        onChange={chooseSource}
      />

      <Card>
        {source === 'mic' ? (
          <>
            <Label>Read this aloud, 4-8 seconds</Label>
            <Text style={{ color: t.ink, fontSize: 17, lineHeight: 29 }}>{transcript}</Text>
            <Bars levels={clip ? shape(clip) : levels} color={t.accent} />
            {(clip || isStreaming) && (
              <Text style={{ color: lengthOk || isStreaming ? t.ok : t.danger, fontFamily: font.semibold, fontSize: 13 }}>
                {isStreaming ? `Recording · ${seconds.toFixed(1)} s` : `${clipSeconds.toFixed(1)} s${lengthOk ? ' · good length' : ' · aim for 4-8 seconds'}`}
              </Text>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isStreaming ? 'Stop recording' : 'Record'}
              onPress={isStreaming ? stop : start}
              style={{ alignSelf: 'center', width: 76, height: 76, borderRadius: 38, backgroundColor: isStreaming ? t.danger : t.accent, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name={isStreaming ? 'square' : 'mic'} size={28} color={t.onAccent} />
            </Pressable>
            {clip && !isStreaming && (
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Button title={playing ? 'Pause' : 'Play'} icon={playing ? 'pause' : 'play'} kind="secondary" small style={{ flex: 1 }} onPress={() => clipUri && void player.toggle(clipUri)} />
                <Button title="Record again" icon="rotate-ccw" kind="secondary" small style={{ flex: 1 }} onPress={start} />
                <Button
                  title="Discard"
                  icon="trash-2"
                  kind="danger"
                  small
                  style={{ flex: 1 }}
                  onPress={() => {
                    player.stop();
                    setClip(null);
                    setSeconds(0);
                    setLevels([]);
                  }}
                />
              </View>
            )}
            {clip && !isStreaming && <CleanNoise clip={clip} onClip={setClip} />}
            <Field label="What you read (edit if you said something else)" value={transcript} onChangeText={setTranscript} multiline style={{ minHeight: 70, textAlignVertical: 'top' }} />
          </>
        ) : (
          <>
            <UploadClip onClip={setClip} />
            {clip && <Bars levels={shape(clip)} color={t.accent} />}
            {clip && <CleanNoise clip={clip} onClip={setClip} />}
            <Field
              label="Exactly what is said in this part"
              value={transcript}
              onChangeText={setTranscript}
              multiline
              placeholder="Type every word you hear, in Telugu script or English letters"
              style={{ minHeight: 80, textAlignVertical: 'top' }}
            />
            {language === 'te' && transcript.trim() !== '' && <ReadAs text={transcript} language={language} onUse={setTranscript} />}
          </>
        )}
      </Card>

      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: consent }}
        onPress={() => setConsent(!consent)}
        style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}
      >
        <View style={{ width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: t.accent, backgroundColor: consent ? t.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
          {consent && <Icon name="check" size={15} color={t.onAccent} />}
        </View>
        <Body style={{ flex: 1, color: t.chipText }}>This is my own voice, or the speaker gave me written permission to clone it.</Body>
      </Pressable>
      <Button title="Create voice" icon="check" onPress={create} busy={busy} disabled={!clip || !name.trim() || !transcript.trim() || !consent || isStreaming} />
      <Text style={{ color: t.soft, fontFamily: font.regular, fontSize: 12, textAlign: 'center' }}>
        Saved only on this phone. You can make it ⚡ fast later from the Voices tab.
      </Text>
      {error && <Notice text={error} kind="error" />}
      <View style={{ height: radius.lg }} />
      {lang ? null : null}
    </Screen>
  );
}
