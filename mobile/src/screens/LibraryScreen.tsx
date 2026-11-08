import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { api, type Generation, type ServerConfig } from '../api';
import { Body, Button, Card, Label, Notice, Title } from '../components/ui';
import { downloadAudio, shareAudio } from '../download';
import { friendlyError } from '../errors';
import { languageByCode } from '../languages';
import { space, useTheme } from '../theme';

const BUSY = new Set(['pending', 'queued', 'loading_model', 'generating']);

function ago(iso: string): string {
  const t = Date.parse(iso.endsWith('Z') || /[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Everything the server has made, including audio Claude made through MCP:
 * play it, save it to Downloads, or share it to an editor like CapCut.
 */
export function LibraryScreen({ config }: { config: ServerConfig }) {
  const t = useTheme();
  const [items, setItems] = useState<Generation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);

  const reload = useCallback(async () => {
    if (!config.url) return;
    setLoading(true);
    setError(null);
    try {
      setItems(await api.listGenerations(config));
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // While something is still being made, check again every few seconds.
  const anyBusy = items.some((g) => BUSY.has(g.status));
  useEffect(() => {
    if (!anyBusy) return;
    const id = setInterval(() => {
      api.listGenerations(config).then(setItems).catch(() => undefined);
    }, 5000);
    return () => clearInterval(id);
  }, [anyBusy, config]);

  /** Runs ``action`` with the generation's local audio file. */
  async function withAudio(g: Generation, action: (uri: string) => Promise<void> | void) {
    setBusyId(g.id);
    setError(null);
    try {
      const file = await api.generationAudio(config, g.id);
      await action(file.uri);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusyId(null);
    }
  }

  async function play(g: Generation) {
    if (current === g.id && status.playing) {
      player.pause();
      return;
    }
    await withAudio(g, async (uri) => {
      await setAudioModeAsync({ playsInSilentMode: true });
      if (current !== g.id) {
        player.replace({ uri });
        setCurrent(g.id);
      } else if (status.duration > 0 && status.currentTime >= status.duration - 0.05) {
        await player.seekTo(0);
      }
      player.play();
    });
  }

  async function remove(g: Generation) {
    try {
      await api.deleteGeneration(config, g.id);
      setConfirmDelete(null);
      if (current === g.id) player.pause();
      setItems((prev) => prev.filter((x) => x.id !== g.id));
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(g) => g.id}
      contentContainerStyle={{ padding: space.lg, gap: space.md }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={t.accent} />}
      ListHeaderComponent={
        <View style={{ gap: space.sm, marginBottom: space.sm }}>
          <Title>Library</Title>
          <Body muted>Everything your server made, including audio you asked Claude for. Pull down to refresh.</Body>
          {!config.url && <Notice text="Connect to your server first." />}
          {error && <Notice text={error} kind="error" />}
        </View>
      }
      ListEmptyComponent={
        !loading && config.url && !error ? (
          <Card>
            <Body muted>Nothing yet. Make something in Speak, or ask Claude to read a script in one of your voices.</Body>
          </Card>
        ) : undefined
      }
      renderItem={({ item: g }) => {
        const lang = languageByCode(g.language);
        const busy = BUSY.has(g.status);
        const failed = g.status === 'failed';
        const playing = current === g.id && status.playing;
        return (
          <Card>
            <Label>
              {g.profile_name} · {lang ? lang.name : g.language}
              {g.duration ? ` · ${g.duration.toFixed(1)} s` : ''} · {ago(g.created_at)}
            </Label>
            <Body style={{ fontSize: 15, lineHeight: 22 }}>{g.text.length > 220 ? `${g.text.slice(0, 220)}…` : g.text}</Body>
            {busy && <Notice text="Still being made…" />}
            {failed && <Notice text={g.error || 'This one failed.'} kind="error" />}
            {!busy && !failed && (
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Button
                  title={playing ? 'Pause' : 'Play'}
                  small
                  onPress={() => void play(g)}
                  busy={busyId === g.id}
                  style={{ flex: 1 }}
                />
                <Button
                  title="Save"
                  kind="secondary"
                  small
                  onPress={() => void withAudio(g, (uri) => downloadAudio(uri, g.profile_name))}
                  disabled={busyId !== null}
                  style={{ flex: 1 }}
                />
                <Button
                  title="Share"
                  kind="secondary"
                  small
                  onPress={() => void withAudio(g, (uri) => shareAudio(uri))}
                  disabled={busyId !== null}
                  style={{ flex: 1 }}
                />
              </View>
            )}
            {confirmDelete === g.id ? (
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Button title="Keep" kind="secondary" small onPress={() => setConfirmDelete(null)} style={{ flex: 1 }} />
                <Button title="Delete from server" kind="danger" small onPress={() => void remove(g)} style={{ flex: 1 }} />
              </View>
            ) : (
              !busy && <Button title="Delete" kind="ghost" small onPress={() => setConfirmDelete(g.id)} />
            )}
          </Card>
        );
      }}
    />
  );
}
