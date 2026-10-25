import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { Alert, Linking, Pressable, Text, View } from 'react-native';
import { usePlayer } from '../components/player';
import { Badge, Button, Card, Empty, Header, Icon, Notice, ProgressBar, Screen } from '../components/ui';
import { forgetTraining, startTraining } from '../edge/kaggleTraining';
import { deletePersonal, importPersonal } from '../edge/personal';
import { deleteVoice, exportForTraining, hasRecording, recordingFile } from '../edge/store';
import { keyOf, type VoiceRef } from '../edge/voices';
import { languageByCode } from '../languages';
import { useApp } from '../state';
import { font, space, useTheme } from '../theme';

const AVATAR = [
  { bg: '#2B1A2E', fg: '#F0A6D8' },
  { bg: '#172433', fg: '#8FC7FF' },
  { bg: '#16281F', fg: '#7EE2A8' },
  { bg: '#231B33', fg: '#C3A6FF' },
];

function VoiceCard({ v, index }: { v: VoiceRef; index: number }) {
  const t = useTheme();
  const app = useApp();
  const player = usePlayer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lang = languageByCode(v.voice.language);
  const training = v.kind === 'f5' ? app.trainings.find((x) => x.voiceId === v.voice.id || (!x.voiceId && x.voiceName === v.voice.name)) : undefined;
  const hasFastTwin = v.kind === 'f5' && app.voices.some((o) => o.kind === 'fast' && o.voice.name.toLowerCase() === v.voice.name.toLowerCase());
  const rec = v.kind === 'f5' && hasRecording(v.voice) ? recordingFile(v.voice).uri : null;
  const avatar = v.kind === 'fast' ? { bg: t.goldBg, fg: t.goldText } : AVATAR[index % AVATAR.length];

  async function makeFast() {
    if (v.kind !== 'f5') return;
    const c = app.creds;
    if (!c?.username || !c.token || !c.hfToken) {
      Alert.alert('Add your keys first', 'Training uses your free Kaggle account. Add your Kaggle username, Kaggle API token and Hugging Face token in Settings.', [
        { text: 'Later' },
        { text: 'Open Settings', onPress: () => app.setTab('settings') },
      ]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await startTraining(v.voice, c);
      app.refreshTrainings();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function remove() {
    Alert.alert(`Delete "${v.voice.name}"?`, 'This voice is removed from the phone. It can’t be undone.', [
      { text: 'Keep' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          if (v.kind === 'fast') deletePersonal(v.voice);
          else deleteVoice(v.voice);
          app.refreshVoices();
        },
      },
    ]);
  }

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: avatar.bg, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: avatar.fg, fontFamily: font.heavy, fontSize: 17 }}>{v.voice.name.slice(0, 2).toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={{ color: t.ink, fontFamily: font.bold, fontSize: 16 }}>{v.voice.name}</Text>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {v.kind === 'fast' ? <Badge text="Fast voice" kind="gold" icon="zap" /> : <Badge text="Big model" />}
            {lang && <Badge text={lang.name} />}
            {training?.state === 'running' && <Badge text="Training" kind="gold" icon="loader" />}
            {training?.state === 'failed' && <Badge text="Training failed" kind="danger" icon="alert-triangle" />}
          </View>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Delete ${v.voice.name}`} onPress={remove} hitSlop={8} style={{ padding: 8 }}>
          <Icon name="trash-2" size={18} color={t.faint} />
        </Pressable>
      </View>

      {training?.state === 'running' && (
        <View style={{ gap: 6 }}>
          <ProgressBar value={Math.min(0.97, (Date.now() - training.startedAt) / 3.6e6 / 4)} color={t.gold} />
          <Notice text={`${training.detail ?? 'Training on Kaggle'}. You can close the app; the fast voice appears here when it's ready.`} />
        </View>
      )}
      {training?.state === 'failed' && (
        <View style={{ gap: 6 }}>
          <Notice text={training.detail ?? 'Training failed.'} kind="error" />
          <View style={{ flexDirection: 'row', gap: space.md }}>
            {training.url && (
              <Text style={{ color: t.accent, fontFamily: font.bold, fontSize: 13 }} onPress={() => void Linking.openURL(training.url as string)}>
                Open on Kaggle
              </Text>
            )}
            <Text
              style={{ color: t.soft, fontFamily: font.bold, fontSize: 13 }}
              onPress={() => {
                forgetTraining(training);
                app.refreshTrainings();
              }}
            >
              Dismiss
            </Text>
          </View>
        </View>
      )}

      <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
        {rec && (
          <Button title={player.isPlaying(rec) ? 'Pause' : 'Recording'} icon={player.isPlaying(rec) ? 'pause' : 'play'} kind="secondary" small style={{ flex: 1 }} onPress={() => void player.toggle(rec)} />
        )}
        <Button
          title="Use in Studio"
          icon="file-text"
          kind="secondary"
          small
          style={{ flex: 1 }}
          onPress={() => {
            app.updatePrefs({ defaultVoice: keyOf(v) });
            app.setTab('studio');
          }}
        />
      </View>
      {v.kind === 'f5' && rec && !hasFastTwin && training?.state !== 'running' && (
        <Button title="Make it fast (free, ~4 h on Kaggle)" icon="zap" kind="gold" small busy={busy} onPress={makeFast} />
      )}
      {v.kind === 'f5' && !rec && <Notice text="Made before recordings were saved: create it again to play its recording or make it fast." />}
      {error && <Notice text={error} kind="error" />}
    </Card>
  );
}

export function VoicesTab() {
  const t = useTheme();
  const app = useApp();
  const [error, setError] = useState<string | null>(null);

  async function importFast() {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({ type: ['application/zip', 'application/octet-stream', '*/*'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    try {
      await importPersonal(res.assets[0].uri);
      app.refreshVoices();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function exportOne() {
    const withRec = app.voices.filter((v) => v.kind === 'f5' && hasRecording(v.voice));
    if (!withRec.length) {
      setError('No voice with a saved recording yet.');
      return;
    }
    Alert.alert(
      'Export a recording',
      'For training by hand with the Kaggle notebook.',
      [
        ...withRec.slice(0, 3).map((v) => ({
          text: v.voice.name,
          onPress: async () => {
            if (v.kind !== 'f5') return;
            const uri = await exportForTraining(v.voice);
            await Sharing.shareAsync(uri, { mimeType: 'application/zip' });
          },
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ],
    );
  }

  return (
    <Screen>
      <Header
        title="Voices"
        subtitle="Saved only on this phone"
        right={<Button title="New voice" icon="plus" small onPress={() => app.setPage({ name: 'newVoice' })} style={{ minHeight: 44 }} />}
      />
      {app.voices.length === 0 ? (
        <Card>
          <Empty
            icon="mic"
            title="No voices yet"
            text="Record 5 seconds of someone speaking (with their permission) or upload a voice note."
            action={<Button title="New voice" icon="plus" onPress={() => app.setPage({ name: 'newVoice' })} style={{ marginTop: space.sm }} />}
          />
        </Card>
      ) : (
        app.voices.map((v, i) => <VoiceCard key={keyOf(v)} v={v} index={i} />)
      )}
      <View style={{ gap: space.sm }}>
        <Button title="Import a fast voice (.zip)" icon="download" kind="secondary" onPress={importFast} />
        <Pressable accessibilityRole="button" onPress={exportOne} style={{ alignSelf: 'center', padding: 8 }}>
          <Text style={{ color: t.soft, fontFamily: font.semibold, fontSize: 13 }}>Export a recording for training by hand</Text>
        </Pressable>
        {error && <Notice text={error} kind="error" />}
      </View>
    </Screen>
  );
}
