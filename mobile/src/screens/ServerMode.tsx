import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { api, type VoiceProfile } from '../api';
import { Header, Segmented } from '../components/ui';
import { useServerConfig } from '../settings';
import { useApp } from '../state';
import { space } from '../theme';
import { SettingsScreen } from './SettingsScreen';
import { SpeakScreen } from './SpeakScreen';
import { VoicesScreen } from './VoicesScreen';

type Sub = 'speak' | 'voices' | 'connection';

/** The optional paid GPU server: its own Speak / Voices / Connection screens. */
export function ServerMode() {
  const app = useApp();
  const { config, loaded, save } = useServerConfig();
  const [sub, setSub] = useState<Sub>('connection');
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!config.url) return setVoices([]);
    setLoading(true);
    setError(null);
    try {
      setVoices(await api.listVoices(config));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    if (loaded) {
      void reload();
      if (config.url) setSub('speak');
    }
  }, [loaded, config.url, reload]);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.md }}>
        <Header title="GPU server" subtitle="Optional · paid by the hour while it runs" onBack={() => app.setPage(null)} />
        <Segmented
          options={[
            { key: 'speak', label: 'Speak' },
            { key: 'voices', label: 'Voices' },
            { key: 'connection', label: 'Connection' },
          ]}
          value={sub}
          onChange={setSub}
        />
      </View>
      <View style={{ flex: 1 }}>
        {sub === 'speak' && <SpeakScreen config={config} voices={voices} onGoToVoices={() => setSub('voices')} />}
        {sub === 'voices' && <VoicesScreen config={config} voices={voices} loading={loading} error={error} reload={reload} />}
        {sub === 'connection' && <SettingsScreen config={config} onSave={save} />}
      </View>
    </View>
  );
}
