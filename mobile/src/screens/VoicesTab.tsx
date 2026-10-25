import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { Alert, Linking, Pressable, Text, View } from 'react-native';
import { usePlayer } from '../components/player';
import { Badge, Button, Card, Empty, Header, Icon, Notice, ProgressBar, Screen } from '../components/ui';
import { expectedHours, forgetTraining, startTraining } from '../edge/kaggleTraining';
import type { TrainingMode } from '../edge/kaggle';
import { deletePersonal } from '../edge/personal';
import { EMOTION_INFO, EMOTIONS } from '../edge/emotions';
import { deleteVoice, emotionRecording, exportForTraining, hasRecording, recordingFile } from '../edge/store';
import { exportVoice, importVoice, keyOf, type VoiceRef } from '../edge/voices';
import { languageByCode } from '../languages';
import { useApp } from '../state';
import { font, space, useTheme } from '../theme';
import { friendlyError } from '../errors';

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
  const [extras, setExtras] = useState(false);
  const lang = languageByCode(v.voice.language);
  const training = v.kind === 'f5' ? app.trainings.find((x) => x.voiceId === v.voice.id || (!x.voiceId && x.voiceName === v.voice.name)) : undefined;
  const hasFastTwin = v.kind === 'f5' && app.voices.some((o) => o.kind === 'fast' && o.voice.name.toLowerCase() === v.voice.name.toLowerCase());
  const rec = v.kind === 'f5' && hasRecording(v.voice) ? recordingFile(v.voice).uri : null;
  const avatar = v.kind === 'fast' ? { bg: t.goldBg, fg: t.goldText } : AVATAR[index % AVATAR.length];

  function chooseFast() {
    Alert.alert('How fast should training be?', 'Both are free on Kaggle. You can close the app; the fast voice appears here when it is done.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Best quality · ~3 h', onPress: () => void makeFast('best') },
      { text: 'Quick · ~1.5 h', onPress: () => void makeFast('quick') },
    ]);
  }

  async function makeFast(mode: TrainingMode) {
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
      await startTraining(v.voice, c, mode);
      app.refreshTrainings();
    } catch (e) {
      setError(friendlyError(e));
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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: t.surface2, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 }}>
        <Icon name="check-circle" size={16} color={t.ok} />
        <Text style={{ color: t.chipText, fontFamily: font.medium, fontSize: 13, flex: 1 }}>
          {v.kind === 'fast' ? 'Ready to use. Speaks in about a second, offline.' : 'Ready to use. Free and works offline. Takes about 30 s per line.'}
        </Text>
      </View>

      {training?.state === 'running' && (
        <View style={{ gap: 6 }}>
          <ProgressBar value={Math.min(0.97, (Date.now() - training.startedAt) / 3.6e6 / expectedHours(training))} color={t.gold} />
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
          <Button title={player.isPlaying(rec) ? 'Pause' : 'Sample'} icon={player.isPlaying(rec) ? 'pause' : 'play'} kind="secondary" small style={{ flex: 1 }} onPress={() => void player.toggle(rec)} />
        )}
        <Button
          title="Share"
          icon="share-2"
          kind="secondary"
          small
          style={{ flex: 1 }}
          onPress={async () => {
            try {
              const uri = await exportVoice(v);
              await Sharing.shareAsync(uri, { mimeType: 'application/zip', dialogTitle: `Share ${v.voice.name}` });
            } catch (e) {
              setError(friendlyError(e));
            }
          }}
        />
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
      {v.kind === 'f5' && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: extras }}
          onPress={() => setExtras(!extras)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}
        >
          <Icon name="sliders" size={15} color={t.soft} />
          <Text style={{ color: t.soft, fontFamily: font.semibold, fontSize: 13, flex: 1 }}>
            Optional extras{!extras ? ' · emotions, faster speaking' : ''}
          </Text>
          <Icon name={extras ? 'chevron-up' : 'chevron-down'} size={18} color={t.soft} />
        </Pressable>
      )}
      {extras && (
        <View style={{ gap: space.md, borderTopWidth: 1, borderTopColor: t.line, paddingTop: space.md }}>
      {v.kind === 'f5' && (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={{ color: t.soft, fontFamily: font.semibold, fontSize: 12 }}>Emotions:</Text>
            {EMOTIONS.filter((e) => v.voice.emotions?.[e]).map((e) => (
              <Pressable key={e} accessibilityRole="button" accessibilityLabel={`Play ${e}`} onPress={() => void player.toggle(emotionRecording(v.voice, e).uri)}>
                <Badge text={EMOTION_INFO[e].label} kind={player.isPlaying(emotionRecording(v.voice, e).uri) ? 'gold' : 'plain'} icon="play" />
              </Pressable>
            ))}
            {!EMOTIONS.some((e) => v.voice.emotions?.[e]) && <Text style={{ color: t.faint, fontFamily: font.regular, fontSize: 12 }}>normal tone only</Text>}
          </View>
          <Text style={{ color: t.soft, fontFamily: font.regular, fontSize: 12, lineHeight: 18 }}>Record the same voice sounding happy, sad, angry… so scripts can use those tones. Without this, emotions are imitated.</Text>
          <Button title="Add emotions" icon="smile" kind="secondary" small onPress={() => app.setPage({ name: 'emotion', voiceId: v.voice.id })} />
        </View>
      )}
      {v.kind === 'fast' && (v.voice.emotions?.length ?? 0) > 0 && (
        <Notice text={`Knows: ${(v.voice.emotions ?? []).map((e) => EMOTION_INFO[e as keyof typeof EMOTION_INFO]?.label ?? e).join(', ')}`} />
      )}
      {v.kind === 'f5' && rec && !hasFastTwin && training?.state !== 'running' && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: t.soft, fontFamily: font.regular, fontSize: 12, lineHeight: 18 }}>
            Optional. Your voice already works without this. It trains a copy that speaks in about 1 second instead of about 30. Free on Kaggle: Quick takes about 1.5 hours, Best quality about 3 (needs a free Kaggle account).
          </Text>
          <Button title="Make it fast" icon="zap" kind="gold" small busy={busy} onPress={chooseFast} />
        </View>
      )}
        </View>
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
      const name = await importVoice(res.assets[0].uri);
      app.refreshVoices();
      Alert.alert('Voice added', `"${name}" is ready to use.`);
    } catch (e) {
      setError(friendlyError(e));
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
      <Card>
        <Text style={{ color: t.ink, fontFamily: font.bold, fontSize: 15 }}>How it works</Text>
        {[
          ['mic', 'Tap New voice and read one line aloud (5-8 seconds), or upload a voice note.'],
          ['edit-3', 'Type anything in Home or Studio.'],
          ['volume-2', 'It speaks in that voice.'],
        ].map(([icon, text], i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={icon as 'mic'} size={15} color={t.accent} />
            </View>
            <Text style={{ color: t.chipText, fontFamily: font.medium, fontSize: 13, flex: 1 }}>{text}</Text>
          </View>
        ))}
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <Badge text="Free" kind="ok" icon="check" />
          <Badge text="Works offline" kind="ok" icon="wifi-off" />
          <Badge text="No account needed" kind="ok" icon="user-x" />
        </View>
      </Card>
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
        <Button title="Import a shared voice (.zip)" icon="download" kind="secondary" onPress={importFast} />
        <Notice text="Voices are shared as a file with Share on a voice card. Only share voices you have permission for." />
        <Pressable accessibilityRole="button" onPress={exportOne} style={{ alignSelf: 'center', padding: 8 }}>
          <Text style={{ color: t.soft, fontFamily: font.semibold, fontSize: 13 }}>Advanced: export a recording for your own training</Text>
        </Pressable>
        {error && <Notice text={error} kind="error" />}
      </View>
    </Screen>
  );
}
