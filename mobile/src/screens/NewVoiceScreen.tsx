import * as DocumentPicker from 'expo-document-picker';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, type ServerConfig } from '../api';
import { Body, Button, Card, Chip, Field, Label, Notice, Title } from '../components/ui';
import { canTranscribe, engineFor, LANGUAGES, type LanguageCode, languageByCode } from '../languages';
import { radius, space, useTheme } from '../theme';
import { friendlyError } from '../errors';

/** IndicF5 clones best from 5-12 seconds; longer clips get cut and stop matching the transcript. */
const MIN_SECONDS = 5;
const IDEAL_MAX_SECONDS = 12;
const HARD_STOP_SECONDS = 15;

export function NewVoiceScreen({
  config,
  onDone,
  onCancel,
}: {
  config: ServerConfig;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<LanguageCode>('te');
  const [clipUri, setClipUri] = useState<string | null>(null);
  const [clipSeconds, setClipSeconds] = useState<number | null>(null);
  const [transcript, setTranscript] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<'transcribe' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recState = useAudioRecorderState(recorder, 200);
  const player = useAudioPlayer(null);
  const playerStatus = useAudioPlayerStatus(player);

  const seconds = recState.isRecording ? recState.durationMillis / 1000 : clipSeconds;
  const lang = languageByCode(language);

  useEffect(() => {
    if (recState.isRecording && recState.durationMillis >= HARD_STOP_SECONDS * 1000) void stopRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recState.isRecording, recState.durationMillis]);

  async function startRecording() {
    setError(null);
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setError('Microphone permission is off. Allow it in your phone settings to record.');
      return;
    }
    player.pause();
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    setClipUri(null);
    setTranscript('');
  }

  async function stopRecording() {
    const duration = recorder.getStatus().durationMillis / 1000;
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    if (recorder.uri) {
      setClipUri(recorder.uri);
      setClipSeconds(duration);
      player.replace({ uri: recorder.uri });
    }
  }

  async function pickFile() {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    setClipUri(res.assets[0].uri);
    setClipSeconds(null);
    setTranscript('');
    player.replace({ uri: res.assets[0].uri });
  }

  async function transcribe() {
    if (!clipUri) return;
    setBusy('transcribe');
    setError(null);
    try {
      const res = await api.transcribe(config, clipUri, language);
      setTranscript(res.text.trim());
      if (clipSeconds === null) setClipSeconds(res.duration);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    if (!clipUri) return;
    setBusy('create');
    setError(null);
    try {
      await api.createVoice(config, {
        name: name.trim(),
        language,
        engine: engineFor(language),
        audioUri: clipUri,
        transcript: transcript.trim(),
      });
      onDone();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  const lengthNote =
    seconds === null
      ? null
      : seconds < MIN_SECONDS
        ? { text: `${seconds.toFixed(1)} s: a bit short. Aim for 5-12 seconds.`, kind: 'error' as const }
        : seconds <= IDEAL_MAX_SECONDS
          ? { text: `${seconds.toFixed(1)} s: good length.`, kind: 'ok' as const }
          : { text: `${seconds.toFixed(1)} s: longer than ideal. 5-12 seconds clones best.`, kind: 'info' as const };

  const canCreate =
    !!clipUri && name.trim().length > 0 && transcript.trim().length > 0 && consent && !recState.isRecording;

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title>New voice</Title>
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>

      <Card>
        <Field label="Voice name" value={name} onChangeText={setName} placeholder="e.g. Priya" maxLength={100} />
        <Label>Language</Label>
        <View style={styles.wrap}>
          {LANGUAGES.map((l) => (
            <Chip
              key={l.code}
              label={l.native === l.name ? l.name : `${l.native} · ${l.name}`}
              selected={language === l.code}
              onPress={() => setLanguage(l.code)}
            />
          ))}
        </View>
      </Card>

      <Card>
        <Label>1. Record 5-12 seconds</Label>
        <Body muted>Quiet room, phone about 20 cm from the mouth, speak naturally.</Body>
        {lang?.readAloud ? (
          <View style={[styles.script, { backgroundColor: t.tint }]}>
            <Text style={{ color: t.ink, fontSize: 17, lineHeight: 26 }}>{lang.readAloud}</Text>
          </View>
        ) : (
          <Body muted>Say two or three everyday sentences in {lang?.name}.</Body>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={recState.isRecording ? 'Stop recording' : 'Start recording'}
          onPress={recState.isRecording ? stopRecording : startRecording}
          style={[styles.mic, { backgroundColor: recState.isRecording ? t.danger : t.accent }]}
        >
          <Text style={{ color: t.onAccent, fontSize: 17, fontWeight: '800' }}>
            {recState.isRecording ? `Stop  ·  ${(recState.durationMillis / 1000).toFixed(1)} s` : 'Record'}
          </Text>
        </Pressable>
        <Button title="Or pick an audio file" kind="secondary" onPress={pickFile} disabled={recState.isRecording} />
        {lengthNote && <Notice text={lengthNote.text} kind={lengthNote.kind} />}
        {clipUri && !recState.isRecording && (
          <Button
            title={playerStatus.playing ? 'Pause' : 'Play back'}
            kind="secondary"
            onPress={() => {
              if (playerStatus.playing) {
                player.pause();
              } else {
                if (playerStatus.duration > 0 && playerStatus.currentTime >= playerStatus.duration - 0.05) {
                  void player.seekTo(0);
                }
                player.play();
              }
            }}
          />
        )}
      </Card>

      <Card>
        <Label>2. Exact words in the clip</Label>
        <Body muted>The clone only works if this matches what was said, word for word, in {lang?.name} script.</Body>
        {canTranscribe(language) && (
          <Button
            title="Fill in automatically"
            kind="secondary"
            onPress={transcribe}
            busy={busy === 'transcribe'}
            disabled={!clipUri || recState.isRecording}
          />
        )}
        <Field
          label="Transcript"
          value={transcript}
          onChangeText={setTranscript}
          multiline
          style={{ minHeight: 90, textAlignVertical: 'top' }}
          placeholder={lang?.readAloud || 'Type exactly what was said'}
        />
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
        <Button title="Create voice" onPress={create} busy={busy === 'create'} disabled={!canCreate} />
        {error && <Notice text={error} kind="error" />}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  script: { borderRadius: radius.md, padding: space.md },
  mic: { minHeight: 64, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
