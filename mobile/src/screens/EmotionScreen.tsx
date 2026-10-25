import { File, Paths } from 'expo-file-system';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { CleanNoise } from '../components/CleanNoise';
import { usePlayer } from '../components/player';
import { clipShape, useRecorder } from '../components/recorder';
import { Badge, Button, Card, Chip, Field, Header, Icon, Label, Notice, Screen, Segmented } from '../components/ui';
import { encodeWav, SAMPLE_RATE } from '../edge/dsp';
import { type Emotion, EMOTION_INFO, EMOTIONS } from '../edge/emotions';
import { deleteEmotion, emotionRecording, listVoices, saveEmotion } from '../edge/store';
import { useApp } from '../state';
import { font, space, useTheme } from '../theme';
import { spokenText } from '../translit';
import { UploadClip } from './UploadClip';
import { friendlyError } from '../errors';

function Bars({ levels }: { levels: number[] }) {
  const t = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 48, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      {levels.map((l, i) => (
        <View key={i} style={{ width: 4, borderRadius: 2, height: Math.max(4, Math.min(48, l * 48)), backgroundColor: l > 0 ? t.accent : t.lineStrong }} />
      ))}
    </View>
  );
}

/** Extra recordings of a voice in other tones: [sad], [excited], … in scripts use them. */
export function EmotionScreen({ voiceId }: { voiceId: string }) {
  const t = useTheme();
  const app = useApp();
  const player = usePlayer();
  const rec = useRecorder(12);
  const [voice, setVoice] = useState(() => listVoices().find((v) => v.id === voiceId));
  const [emotion, setEmotion] = useState<Emotion>(() => EMOTIONS.find((e) => !voice?.emotions?.[e]) ?? 'happy');
  const [source, setSource] = useState<'mic' | 'file'>('mic');
  const [text, setText] = useState(EMOTION_INFO[emotion].read);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (source === 'mic') setText(EMOTION_INFO[emotion].read);
    rec.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emotion, source]);

  const clipUri = useMemo(() => {
    if (!rec.clip) return null;
    const f = new File(Paths.cache, `swaram-emotion-${Date.now()}.wav`);
    f.writeSync(encodeWav(rec.clip));
    return f.uri;
  }, [rec.clip]);

  if (!voice) {
    return (
      <Screen>
        <Header title="Emotions" onBack={() => app.setPage(null)} />
        <Notice text="This voice was deleted." kind="error" />
      </Screen>
    );
  }

  const has = voice.emotions?.[emotion];
  const clipSeconds = rec.clip ? rec.clip.length / SAMPLE_RATE : rec.seconds;
  const lengthOk = clipSeconds >= 3 && clipSeconds <= 10;

  async function save() {
    if (!rec.clip || !voice) return;
    setBusy(true);
    setError(null);
    try {
      if (!app.installed) throw new Error('Download the offline model in Settings first.');
      const eng = await app.getEngine();
      const data = await eng.makeVoice(rec.clip, spokenText(text, voice.language));
      setVoice(saveEmotion(voice, emotion, data, rec.clip));
      app.refreshVoices();
      rec.reset();
      const next = EMOTIONS.find((e) => e !== emotion && !voice.emotions?.[e]);
      if (next) setEmotion(next);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Header title={`${voice.name} · emotions`} subtitle="Optional. Each one makes tagged lines sound like it." onBack={() => app.setPage(null)} />

      <Card>
        <Label>Emotion</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {EMOTIONS.map((e) => (
            <Chip key={e} label={`${EMOTION_INFO[e].label}${voice.emotions?.[e] ? ' ✓' : ''}`} selected={emotion === e} onPress={() => setEmotion(e)} />
          ))}
        </View>
        <Notice text={`In scripts: [${emotion}] or Name (${emotion}): … · Telugu: [${EMOTION_INFO[emotion].telugu}]`} />
        {has && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
            <Badge text="Recorded" kind="ok" icon="check" />
            <Button
              title={player.isPlaying(emotionRecording(voice, emotion).uri) ? 'Pause' : 'Play'}
              icon="play"
              kind="secondary"
              small
              onPress={() => void player.toggle(emotionRecording(voice, emotion).uri)}
            />
            <Button
              title="Remove"
              icon="trash-2"
              kind="danger"
              small
              onPress={() =>
                Alert.alert(`Remove the ${EMOTION_INFO[emotion].label.toLowerCase()} recording?`, '', [
                  { text: 'Keep' },
                  {
                    text: 'Remove',
                    style: 'destructive',
                    onPress: () => {
                      setVoice(deleteEmotion(voice, emotion));
                      app.refreshVoices();
                    },
                  },
                ])
              }
            />
          </View>
        )}
      </Card>

      <Segmented
        options={[
          { key: 'mic', label: has ? 'Record again' : 'Record now' },
          { key: 'file', label: 'Upload a clip' },
        ]}
        value={source}
        onChange={setSource}
      />

      <Card>
        {source === 'mic' ? (
          <>
            <Label>{`Read this ${EMOTION_INFO[emotion].how}, 3-8 seconds`}</Label>
            <Text style={{ color: t.ink, fontSize: 17, lineHeight: 29 }}>{text}</Text>
            <Text style={{ color: t.soft, fontFamily: font.medium, fontSize: 13 }}>{EMOTION_INFO[emotion].hint} Acted, clear emotion works best.</Text>
            <Bars levels={rec.clip ? clipShape(rec.clip) : rec.levels} />
            {(rec.clip || rec.isStreaming) && (
              <Text style={{ color: lengthOk || rec.isStreaming ? t.ok : t.danger, fontFamily: font.semibold, fontSize: 13 }}>
                {rec.isStreaming ? `Recording · ${rec.seconds.toFixed(1)} s` : `${clipSeconds.toFixed(1)} s${lengthOk ? ' · good length' : ' · aim for 3-8 seconds'}`}
              </Text>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={rec.isStreaming ? 'Stop recording' : 'Record'}
              onPress={rec.isStreaming ? rec.stop : () => {
                player.stop();
                void rec.start();
              }}
              style={{ alignSelf: 'center', width: 72, height: 72, borderRadius: 36, backgroundColor: rec.isStreaming ? t.danger : t.accent, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name={rec.isStreaming ? 'square' : 'mic'} size={26} color={t.onAccent} />
            </Pressable>
            <Field label="What you read" value={text} onChangeText={setText} multiline style={{ minHeight: 64, textAlignVertical: 'top' }} />
          </>
        ) : (
          <>
            <UploadClip onClip={rec.setClip} />
            <Field label="Exactly what is said in this part" value={text} onChangeText={setText} multiline placeholder="Type every word you hear" style={{ minHeight: 64, textAlignVertical: 'top' }} />
          </>
        )}
        {rec.clip && !rec.isStreaming && (
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button title={clipUri && player.isPlaying(clipUri) ? 'Pause' : 'Play'} icon="play" kind="secondary" small style={{ flex: 1 }} onPress={() => clipUri && void player.toggle(clipUri)} />
            <Button title="Discard" icon="trash-2" kind="danger" small style={{ flex: 1 }} onPress={rec.reset} />
          </View>
        )}
        {rec.clip && !rec.isStreaming && <CleanNoise clip={rec.clip} onClip={rec.setClip} />}
        <Button title={`Save ${EMOTION_INFO[emotion].label.toLowerCase()} tone`} icon="check" onPress={save} busy={busy} disabled={!rec.clip || !text.trim() || rec.isStreaming} />
        {(error || rec.error) && <Notice text={error ?? rec.error ?? ''} kind="error" />}
      </Card>
    </Screen>
  );
}
