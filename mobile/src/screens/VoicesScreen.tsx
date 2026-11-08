import { useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { api, type ServerConfig, type VoiceProfile } from '../api';
import { Body, Button, Card, Label, Notice, Title } from '../components/ui';
import { languageByCode } from '../languages';
import { space, useTheme } from '../theme';
import { DesignVoiceScreen } from './DesignVoiceScreen';
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
  const [creating, setCreating] = useState<'clone' | 'design' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (creating) {
    const Screen = creating === 'design' ? DesignVoiceScreen : NewVoiceScreen;
    return (
      <Screen
        config={config}
        onCancel={() => setCreating(null)}
        onDone={() => {
          setCreating(null);
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
          <Button title="+ Clone a new voice" onPress={() => setCreating('clone')} disabled={!config.url} />
          <Button
            title="+ Describe a new voice"
            kind="secondary"
            onPress={() => setCreating('design')}
            disabled={!config.url}
          />
          {!config.url && <Notice text="Connect to your server in Settings first." />}
          {error && <Notice text={error} kind="error" />}
          {deleteError && <Notice text={deleteError} kind="error" />}
        </View>
      }
      ListEmptyComponent={
        !loading && config.url && !error ? (
          <Card>
            <Body muted>No voices yet. Clone one from a 5-12 second recording, or describe one in words.</Body>
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
