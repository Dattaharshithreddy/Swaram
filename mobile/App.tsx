import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { api, type VoiceProfile } from './src/api';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SpeakScreen } from './src/screens/SpeakScreen';
import { VoicesScreen } from './src/screens/VoicesScreen';
import { useServerConfig } from './src/settings';
import { useTheme } from './src/theme';

type Tab = 'speak' | 'voices' | 'settings';

const TABS: { key: Tab; label: string }[] = [
  { key: 'speak', label: 'Speak' },
  { key: 'voices', label: 'Voices' },
  { key: 'settings', label: 'Settings' },
];

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const t = useTheme();
  const { config, loaded, save } = useServerConfig();
  const [tab, setTab] = useState<Tab>('speak');
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);

  const reloadVoices = useCallback(async () => {
    if (!config.url) {
      setVoices([]);
      return;
    }
    setLoadingVoices(true);
    setVoicesError(null);
    try {
      setVoices(await api.listVoices(config));
    } catch (e) {
      setVoicesError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingVoices(false);
    }
  }, [config]);

  useEffect(() => {
    if (loaded) void reloadVoices();
  }, [loaded, reloadVoices]);

  useEffect(() => {
    if (loaded && !config.url) setTab('settings');
  }, [loaded, config.url]);

  if (!loaded) {
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        <ActivityIndicator color={t.accent} />
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top', 'left', 'right']}>
      <StatusBar style="auto" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1 }}>
          {tab === 'speak' && <SpeakScreen config={config} voices={voices} onGoToVoices={() => setTab('voices')} />}
          {tab === 'voices' && (
            <VoicesScreen
              config={config}
              voices={voices}
              loading={loadingVoices}
              error={voicesError}
              reload={reloadVoices}
            />
          )}
          {tab === 'settings' && <SettingsScreen config={config} onSave={save} />}
        </View>
      </KeyboardAvoidingView>
      <SafeAreaView edges={['bottom']} style={[styles.tabBar, { borderColor: t.line, backgroundColor: t.surface }]}>
        {TABS.map((item) => {
          const active = item.key === tab;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setTab(item.key)}
              style={styles.tab}
            >
              <View style={[styles.tabDot, { backgroundColor: active ? t.accent : 'transparent' }]} />
              <Text style={{ color: active ? t.ink : t.soft, fontWeight: active ? '800' : '600', fontSize: 14 }}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </SafeAreaView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabBar: { flexDirection: 'row', borderTopWidth: 1 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, gap: 4 },
  tabDot: { width: 18, height: 3, borderRadius: 2 },
});
