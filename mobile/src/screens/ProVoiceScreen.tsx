import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { usePlayer } from '../components/player';
import { clipShape, useRecorder } from '../components/recorder';
import { Body, Button, Card, Header, Icon, Notice, ProgressBar, Screen } from '../components/ui';
import { SAMPLE_RATE, trimSilence } from '../edge/dsp';
import {
  deleteProClip,
  hasProClip,
  nextProSentence,
  PRO_GOOD_MINUTES,
  PRO_HOURS,
  PRO_MIN_MINUTES,
  proClipFile,
  proProgress,
  saveProClip,
  startStudioVoice,
} from '../edge/proVoice';
import { PRO_SENTENCES } from '../edge/proSentences';
import { listVoices } from '../edge/store';
import { friendlyError } from '../errors';
import { useApp } from '../state';
import { font, space, useTheme } from '../theme';

function Bars({ levels }: { levels: number[] }) {
  const t = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 44, flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      {levels.map((l, i) => (
        <View key={i} style={{ width: 4, borderRadius: 2, height: Math.max(4, Math.min(44, l * 44)), backgroundColor: l > 0 ? t.gold : t.lineStrong }} />
      ))}
    </View>
  );
}

/** Read sentences one after another for a studio voice; each one is saved as soon as you stop. */
export function ProVoiceScreen({ voiceId }: { voiceId: string }) {
  const t = useTheme();
  const app = useApp();
  const player = usePlayer();
  const rec = useRecorder(20);
  const voice = listVoices().find((v) => v.id === voiceId);
  const [n, setN] = useState(() => (voice ? nextProSentence(voice) : 0));
  const [progress, setProgress] = useState(() => (voice ? proProgress(voice) : { minutes: 0, done: 0, total: PRO_SENTENCES.length }));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stopping saves the take and moves on to the next sentence.
  useEffect(() => {
    if (!voice || !rec.clip || rec.isStreaming) return;
    const clip = trimSilence(rec.clip);
    if (clip.length < SAMPLE_RATE * 0.8) {
      setError('That was too short. Read the whole sentence, then tap stop.');
      rec.reset();
      return;
    }
    saveProClip(voice, n, clip);
    setProgress(proProgress(voice));
    setError(null);
    rec.reset();
    setN((x) => Math.min(PRO_SENTENCES.length - 1, x + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.clip, rec.isStreaming]);

  if (!voice) {
    return (
      <Screen>
        <Header title="Studio voice" onBack={() => app.setPage(null)} />
        <Notice text="This voice was deleted." kind="error" />
      </Screen>
    );
  }

  const recorded = hasProClip(voice, n);
  const enough = progress.minutes >= PRO_MIN_MINUTES;

  async function train() {
    if (!voice) return;
    const c = app.creds;
    if (!c?.username || !c.token || !c.hfToken) {
      Alert.alert('Add your Kaggle keys first', 'Training uses your free Kaggle account. Add your keys in Settings.', [
        { text: 'Later' },
        { text: 'Open Settings', onPress: () => app.setTab('settings') },
      ]);
      return;
    }
    setError(null);
    setBusy('Preparing…');
    try {
      await startStudioVoice(voice, c, setBusy);
      app.refreshTrainings();
      app.setPage(null);
      app.setTab('voices');
      Alert.alert('Studio voice training started', `It takes about ${PRO_HOURS + 0.5} hours on Kaggle. You can close the app. When it's ready, "Studio render on Kaggle" uses it automatically.`);
    } catch (e) {
      setError(friendlyError(e, 'kaggle'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen>
      <Header title={`Studio voice · ${voice.name}`} onBack={() => app.setPage(null)} />
      <Card>
        <Body>
          Read the sentences below in your natural voice, one at a time. About {PRO_GOOD_MINUTES} minutes of reading teaches the big model
          your voice itself, so it sounds much more like you than a 10-second clone. You can stop and continue later.
        </Body>
        <ProgressBar value={Math.min(1, progress.minutes / PRO_GOOD_MINUTES)} color={t.gold} />
        <Text style={{ color: t.soft, fontFamily: font.medium, fontSize: 12 }}>
          {progress.minutes.toFixed(1)} min recorded · {progress.done} of {progress.total} sentences
          {enough ? '' : ` · at least ${PRO_MIN_MINUTES} min needed`}
        </Text>
      </Card>

      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: t.soft, fontFamily: font.bold, fontSize: 12 }}>
            SENTENCE {n + 1} OF {PRO_SENTENCES.length} {recorded ? '· ✓ recorded' : ''}
          </Text>
          <View style={{ flexDirection: 'row', gap: space.lg }}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous sentence" disabled={rec.isStreaming || n === 0} onPress={() => setN(n - 1)} hitSlop={10}>
              <Icon name="chevron-left" color={n === 0 ? t.faint : t.ink} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next sentence"
              disabled={rec.isStreaming || n >= PRO_SENTENCES.length - 1}
              onPress={() => setN(n + 1)}
              hitSlop={10}
            >
              <Icon name="chevron-right" color={n >= PRO_SENTENCES.length - 1 ? t.faint : t.ink} />
            </Pressable>
          </View>
        </View>
        <Text style={{ color: t.ink, fontSize: 21, lineHeight: 34 }}>{PRO_SENTENCES[n]}</Text>
        <Bars levels={rec.isStreaming ? rec.levels : rec.clip ? clipShape(rec.clip) : []} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={rec.isStreaming ? 'Stop and save' : 'Record this sentence'}
          onPress={rec.isStreaming ? rec.stop : () => {
            player.stop();
            void rec.start();
          }}
          style={{ alignSelf: 'center', width: 76, height: 76, borderRadius: 38, backgroundColor: rec.isStreaming ? t.danger : t.gold, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name={rec.isStreaming ? 'square' : 'mic'} size={28} color={t.onAccent} />
        </Pressable>
        <Text style={{ color: t.soft, fontFamily: font.medium, fontSize: 12, textAlign: 'center' }}>
          {rec.isStreaming ? `Recording · ${rec.seconds.toFixed(1)} s · tap stop when done` : 'Tap, read the sentence, tap stop. It saves and moves on.'}
        </Text>
        {recorded && !rec.isStreaming && (
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button
              title={player.isPlaying(proClipFile(voice, n).uri) ? 'Pause' : 'Play'}
              icon={player.isPlaying(proClipFile(voice, n).uri) ? 'pause' : 'play'}
              kind="secondary"
              small
              style={{ flex: 1 }}
              onPress={() => void player.toggle(proClipFile(voice, n).uri)}
            />
            <Button
              title="Delete take"
              icon="trash-2"
              kind="danger"
              small
              style={{ flex: 1 }}
              onPress={() => {
                player.stop();
                deleteProClip(voice, n);
                setProgress(proProgress(voice));
              }}
            />
          </View>
        )}
        {(error || rec.error) && <Notice text={(error || rec.error) as string} kind="error" />}
      </Card>

      <Notice text="Quiet room, same distance from the phone each time, your normal pace. Re-record a sentence any time with the arrows." />
      <Button
        title={busy ?? (enough ? 'Train my studio voice on Kaggle' : `Record ${Math.max(0, PRO_MIN_MINUTES - progress.minutes).toFixed(1)} more min to train`)}
        icon="zap"
        kind="gold"
        busy={busy !== null}
        disabled={!enough || rec.isStreaming}
        onPress={() => void train()}
      />
      <Text style={{ color: t.soft, fontFamily: font.regular, fontSize: 12, textAlign: 'center' }}>
        Uploads the recordings to your private Kaggle account (Wi-Fi recommended) and trains for about {PRO_HOURS} hours, free.
      </Text>
    </Screen>
  );
}
