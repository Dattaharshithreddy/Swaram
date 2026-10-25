import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { usePlayer } from '../components/player';
import { ReadAs } from '../components/ReadAs';
import { Badge, Button, Card, CardTitle, Chip, Empty, Icon, IconButton, Notice, ProgressBar, Screen } from '../components/ui';
import { downloadAudio, shareAudio } from '../download';
import { ago, duration, type RecentItem, removeRecent } from '../edge/recent';
import { displayName, keyOf } from '../edge/voices';
import { languageByCode } from '../languages';
import { useApp } from '../state';
import { font, radius, space, useTheme } from '../theme';
import { friendlyError } from '../errors';

export function RecentRow({ item, onRemoved }: { item: RecentItem; onRemoved?: () => void }) {
  const t = useTheme();
  const player = usePlayer();
  const playing = player.isPlaying(item.uri);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 16, padding: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playing ? 'Pause' : 'Play'}
        onPress={() => void player.toggle(item.uri)}
        style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: playing ? t.accent : t.surface2, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name={playing ? 'pause' : 'play'} size={16} color={playing ? t.onAccent : t.ink} />
      </Pressable>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: t.ink, fontFamily: font.semibold, fontSize: 14 }}>
          {item.title}
        </Text>
        <Text numberOfLines={1} style={{ color: t.soft, fontFamily: font.regular, fontSize: 12 }}>
          {item.voiceName} · {duration(item.seconds)} · {ago(item.at)}
        </Text>
      </View>
      <IconButton icon="download" label="Download" onPress={() => void downloadAudio(item.uri, item.title)} />
      <IconButton icon="share-2" label="Share" onPress={() => void shareAudio(item.uri)} />
      {onRemoved && (
        <IconButton
          icon="x"
          label="Remove from recent"
          onPress={() => {
            removeRecent(item.id);
            onRemoved();
          }}
        />
      )}
    </View>
  );
}

export function HomeScreen() {
  const t = useTheme();
  const app = useApp();
  const { voices, prefs, updatePrefs, recent, trainings, running } = app;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const player = usePlayer();

  const selected = voices.find((v) => keyOf(v) === prefs.defaultVoice) ?? voices[0];
  const lang = languageByCode(selected?.voice.language);
  const activeTrainings = trainings.filter((x) => x.state === 'running');

  useEffect(() => {
    if (!prefs.defaultVoice && voices[0]) updatePrefs({ defaultVoice: keyOf(voices[0]) });
  }, [prefs.defaultVoice, voices, updatePrefs]);

  async function speak() {
    if (!selected || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const item = await app.speakQuick(selected, text, (done, total) => setProgress({ done, total }));
      await player.toggle(item.uri);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const statusChips = (
    <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
      {app.installed ? <Badge text="Offline ready" kind="ok" icon="check-circle" /> : <Badge text="Model not downloaded" kind="danger" icon="download" />}
      <Badge text={`${voices.length} voice${voices.length === 1 ? '' : 's'}`} />
      {activeTrainings.length > 0 && <Badge text={`${activeTrainings.length} training`} kind="gold" icon="zap" />}
      {running && <Badge text="Making a script" kind="gold" icon="loader" />}
    </View>
  );

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingTop: space.sm }}>
        <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="bar-chart-2" size={20} color={t.onAccent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.ink, fontFamily: font.heavy, fontSize: 21, letterSpacing: -0.3 }}>Swaram</Text>
          <Text style={{ color: t.soft, fontFamily: font.medium, fontSize: 12 }}>Your voice, on your phone</Text>
        </View>
        <IconButton icon="settings" label="Settings" filled onPress={() => app.setTab('settings')} />
      </View>
      {statusChips}

      {!app.installed && voices.length === 0 ? (
        <Card>
          <Empty
            icon="download-cloud"
            title="Set up offline voices"
            text="Download the voice model once (about 450 MB, Wi-Fi). Then clone voices and speak with no internet."
            action={<Button title="Go to Settings" icon="settings" onPress={() => app.setTab('settings')} style={{ marginTop: space.sm }} />}
          />
        </Card>
      ) : voices.length === 0 ? (
        <Card>
          <Empty
            icon="mic"
            title="Make your first voice"
            text="Record 5 seconds or upload a voice note. It stays on this phone."
            action={<Button title="New voice" icon="plus" onPress={() => app.setPage({ name: 'newVoice' })} style={{ marginTop: space.sm }} />}
          />
        </Card>
      ) : (
        <Card>
          <CardTitle right={<Text style={{ color: t.soft, fontFamily: font.medium, fontSize: 12 }}>{lang?.name ?? ''}</Text>}>Quick speak</CardTitle>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {voices.map((v) => (
              <Chip
                key={keyOf(v)}
                label={v.voice.name}
                gold={v.kind === 'fast'}
                selected={selected && keyOf(v) === keyOf(selected)}
                onPress={() => updatePrefs({ defaultVoice: keyOf(v) })}
              />
            ))}
          </View>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={lang?.example || 'Type what the voice should say'}
            placeholderTextColor={t.faint}
            accessibilityLabel="Text to speak"
            style={{ minHeight: 96, maxHeight: 220, textAlignVertical: 'top', borderRadius: radius.md, borderWidth: 1, borderColor: t.lineStrong, backgroundColor: t.field, color: t.ink, padding: 12, fontSize: 16, lineHeight: 26 }}
          />
          {selected && <ReadAs text={text} language={selected.voice.language} onUse={setText} />}
          {busy && <ProgressBar value={progress ? progress.done / Math.max(1, progress.total) : 0.03} />}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
            <Text style={{ color: t.soft, fontFamily: font.medium, fontSize: 12, flex: 1 }}>
              {busy
                ? app.engineLoading
                  ? 'Loading the model…'
                  : 'Making it on this phone…'
                : selected?.kind === 'fast'
                  ? `${displayName(selected)} · about a second`
                  : `Big model · ${prefs.steps === 8 ? 'Fast' : prefs.steps === 16 ? 'Balanced' : 'Best'} · ~30 s`}
            </Text>
            <Button title="Speak" icon="play" onPress={speak} busy={busy} disabled={!text.trim() || !selected} style={{ paddingHorizontal: 22 }} />
          </View>
          {error && <Notice text={error} kind="error" />}
        </Card>
      )}

      {activeTrainings.length > 0 && (
        <Card>
          <CardTitle
            right={
              <Pressable accessibilityRole="button" onPress={() => void app.checkTrainings()}>
                <Text style={{ color: t.accent, fontFamily: font.bold, fontSize: 13 }}>{app.checkingTrainings ? 'Checking…' : 'Check now'}</Text>
              </Pressable>
            }
          >
            Training on Kaggle
          </CardTitle>
          {activeTrainings.map((tr) => {
            const hours = (Date.now() - tr.startedAt) / 3.6e6;
            return (
              <View key={tr.id} style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: t.ink, fontFamily: font.semibold, fontSize: 13 }}>⚡ {tr.voiceName}</Text>
                  <Text style={{ color: t.soft, fontFamily: font.regular, fontSize: 12 }}>{hours.toFixed(1)} h of about 4 h</Text>
                </View>
                <ProgressBar value={Math.min(0.97, hours / 4)} color={t.gold} />
              </View>
            );
          })}
        </Card>
      )}

      <View style={{ gap: space.sm }}>
        <CardTitle
          right={
            recent.length > 3 ? (
              <Pressable accessibilityRole="button" onPress={() => setShowAll(!showAll)}>
                <Text style={{ color: t.accent, fontFamily: font.bold, fontSize: 13 }}>{showAll ? 'Show less' : `See all (${recent.length})`}</Text>
              </Pressable>
            ) : undefined
          }
        >
          Recent
        </CardTitle>
        {recent.length === 0 ? (
          <Notice text="Everything you make shows up here, ready to play, download or share." />
        ) : (
          (showAll ? recent : recent.slice(0, 3)).map((r) => <RecentRow key={r.id} item={r} onRemoved={showAll ? app.refreshRecent : undefined} />)
        )}
      </View>
    </Screen>
  );
}
