import { useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { api, type ServerConfig, type VoiceProfile } from '../api';
import { Body, Button, Card, Label, Notice, Title } from '../components/ui';
import { languageByCode } from '../languages';
import { space, useTheme } from '../theme';
import { NewVoiceScreen } from './NewVoiceScreen';
import { friendlyError } from '../errors';

export function VoicesScreen({
  config,
  voices,
  loading,
  error,
  reload,
}: {
  config: ServerConfig;
  voices: VoiceProfile[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}) {
  const t = useTheme();
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (creating) {
    return (
      <NewVoiceScreen
        config={config}
        onCancel={() => setCreating(false)}
        onDone={() => {
          setCreating(false);
          reload();
        }}
      />
    );
  }

  async function remove(id: string) {
    setDeleteError(null);
    try {
      await api.deleteVoice(config, id);
      setConfirmDelete(null);
      reload();
    } catch (e) {
      setDeleteError(friendlyError(e));
    }
  }

  return (
    <FlatList
      data={voices}
      keyExtractor={(v) => v.id}
      contentContainerStyle={{ padding: space.lg, gap: space.md }}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={t.accent} />}
      ListHeaderComponent={
        <View style={{ gap: space.md, marginBottom: space.sm }}>
          <Title>Voices</Title>
          <Button title="+ Clone a new voice" onPress={() => setCreating(true)} disabled={!config.url} />
          {!config.url && <Notice text="Connect to your server in Settings first." />}
          {error && <Notice text={error} kind="error" />}
          {deleteError && <Notice text={deleteError} kind="error" />}
        </View>
      }
      ListEmptyComponent={
        !loading && config.url && !error ? (
          <Card>
            <Body muted>No voices yet. Clone one from a 5-12 second recording.</Body>
          </Card>
        ) : undefined
      }
      renderItem={({ item }) => {
        const lang = languageByCode(item.language);
        return (
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Body>{item.name}</Body>
                <Label>
                  {lang ? lang.name : item.language} · {item.default_engine ?? 'default engine'}
                </Label>
              </View>
              {confirmDelete === item.id ? (
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Button title="Keep" kind="secondary" onPress={() => setConfirmDelete(null)} />
                  <Button title="Delete" kind="danger" onPress={() => remove(item.id)} />
                </View>
              ) : (
                <Button title="Delete" kind="secondary" onPress={() => setConfirmDelete(item.id)} />
              )}
            </View>
          </Card>
        );
      }}
    />
  );
}
