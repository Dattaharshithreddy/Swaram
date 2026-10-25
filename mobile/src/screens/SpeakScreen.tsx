import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Sharing from 'expo-sharing';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, type ServerConfig, type VoiceProfile } from '../api';
import { Body, Button, Card, Chip, Field, Label, Notice, Title } from '../components/ui';
import { languageByCode } from '../languages';
import { radius, space, useTheme } from '../theme';
import { ReadAs } from '../components/ReadAs';
import { downloadAudio } from '../download';
import { spokenText } from '../translit';

interface Take {
  uri: string;
  voice: string;
  text: string;
  at: number;
}

const MAX_CHARS = 2000;

export function SpeakScreen({
  config,
  voices,
  onGoToVoices,
}: {
  config: ServerConfig;
  voices: VoiceProfile[];
  onGoToVoices: () => void;
}) {
  const t = useTheme();
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);

  const voice = voices.find((v) => v.id === voiceId) ?? voices[0];
  const lang = languageByCode(voice?.language);

  useEffect(() => {
    if (!voiceId && voices[0]) setVoiceId(voices[0].id);
  }, [voices, voiceId]);

  function play(uri: string) {
    if (current === uri && status.playing) {
      player.pause();
      return;
    }
    if (current !== uri) {
      player.replace({ uri });
      setCurrent(uri);
    } else if (status.duration > 0 && status.currentTime >= status.duration - 0.05) {
      void player.seekTo(0);
    }
    player.play();
  }

  async function generate() {
    if (!voice || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await setAudioModeAsync({ playsInSilentMode: true });
      const file = await api.speak(config, voice.id, spokenText(text.trim(), voice.language));
      const take = { uri: file.uri, voice: voice.name, text: text.trim(), at: Date.now() };
      setTakes((prev) => [take, ...prev].slice(0, 20));
      play(file.uri);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function share(uri: string) {
    try {
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { dialogTitle: 'Share audio' });
      else setError('Sharing is not available on this device.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!config.url) {
    return (
      <View style={{ padding: space.lg, gap: space.lg }}>
        <Title>స్వరం Swaram</Title>
        <Card>
          <Body>Clone a voice once, then make it speak Telugu, Hindi, English and 9 more languages.</Body>
          <Body muted>Start by connecting to your Swaram server in Settings.</Body>
        </Card>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Title>Speak</Title>

      {voices.length === 0 ? (
        <Card>
          <Body>No voices yet.</Body>
          <Button title="Clone your first voice" onPress={onGoToVoices} />
        </Card>
      ) : (
        <Card>
          <Label>Voice</Label>
          <View style={styles.wrap}>
            {voices.map((v) => (
              <Chip key={v.id} label={v.name} selected={v.id === voice?.id} onPress={() => setVoiceId(v.id)} />
            ))}
          </View>
          <Field
            label={`Text${lang ? ` in ${lang.name}` : ''}`}
            value={text}
            onChangeText={(s) => setText(s.slice(0, MAX_CHARS))}
            multiline
            placeholder={lang?.example || 'Type what the voice should say'}
            style={{ minHeight: 130, textAlignVertical: 'top', fontSize: 17, lineHeight: 26 }}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Notice text={`${text.length}/${MAX_CHARS}`} />
            {lang?.example ? (
              <Text style={{ color: t.accent, fontWeight: '600' }} onPress={() => setText(lang.example)}>
                Use example
              </Text>
            ) : null}
          </View>
          <ReadAs text={text} language={voice?.language} onUse={(s) => setText(s.slice(0, MAX_CHARS))} />
          <Button title="Generate" onPress={generate} busy={busy} disabled={!text.trim() || !voice} />
          {busy && <Notice text="Generating on the server. Short lines take a few seconds." />}
          {error && <Notice text={error} kind="error" />}
        </Card>
      )}

      {takes.length > 0 && (
        <View style={{ gap: space.md }}>
          <Label>Recent</Label>
          {takes.map((take) => {
            const active = current === take.uri && status.playing;
            return (
              <View key={take.uri} style={[styles.take, { borderColor: active ? t.accent : t.line, backgroundColor: t.surface }]}>
                <Text numberOfLines={2} style={{ color: t.ink, fontSize: 15, lineHeight: 22 }}>
                  {take.text}
                </Text>
                <Text style={{ color: t.soft, fontSize: 12 }}>
                  {take.voice} · {new Date(take.at).toLocaleTimeString()}
                </Text>
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Button title={active ? 'Pause' : 'Play'} kind="secondary" onPress={() => play(take.uri)} style={{ flex: 1 }} />
                  <Button title="Download" kind="secondary" onPress={() => downloadAudio(take.uri, take.voice)} style={{ flex: 1 }} />
                  <Button title="Share" kind="secondary" onPress={() => share(take.uri)} style={{ flex: 1 }} />
                </View>
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  take: { borderWidth: 1.5, borderRadius: radius.lg, padding: space.md, gap: space.sm },
});
