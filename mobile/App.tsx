import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/plus-jakarta-sans';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { PlayerProvider } from './src/components/player';
import { Icon, type IconName } from './src/components/ui';
import { runSelfTest } from './src/edge/selftest';
import { HomeScreen } from './src/screens/HomeScreen';
import { NewVoiceScreen2 } from './src/screens/NewVoiceScreen2';
import { ServerMode } from './src/screens/ServerMode';
import { SettingsTab } from './src/screens/SettingsTab';
import { StudioScreen } from './src/screens/StudioScreen';
import { VoicesTab } from './src/screens/VoicesTab';
import { AppProvider, type Tab, useApp } from './src/state';
import { font, useTheme } from './src/theme';

const TABS: { key: Tab; label: string; icon: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'studio', label: 'Studio', icon: 'file-text' },
  { key: 'voices', label: 'Voices', icon: 'mic' },
  { key: 'settings', label: 'Settings', icon: 'sliders' },
];

export default function App() {
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });
  const t = useTheme();

  // swaram://selftest[?provider=cpu] runs the offline engine end to end (used by CI).
  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      if (!url?.startsWith('swaram://selftest')) return;
      const provider = /provider=(cpu|xnnpack|nnapi)/.exec(url)?.[1] as 'cpu' | 'xnnpack' | 'nnapi' | undefined;
      void runSelfTest(provider ?? 'xnnpack');
    });
  }, []);

  if (!fontsLoaded) {
    return (
      <View style={[styles.center, { backgroundColor: t.bg }]}>
        <ActivityIndicator color={t.accent} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <AppProvider>
        <PlayerProvider>
          <Main />
        </PlayerProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}

function Main() {
  const t = useTheme();
  const { tab, setTab, page, setPage } = useApp();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ErrorBoundary resetKey={`${tab}-${page?.name ?? ''}`}>
          <View style={{ flex: 1 }}>
            {page?.name === 'newVoice' ? (
              <NewVoiceScreen2 />
            ) : page?.name === 'server' ? (
              <ServerMode />
            ) : (
              <>
                {tab === 'home' && <HomeScreen />}
                {tab === 'studio' && <StudioScreen />}
                {tab === 'voices' && <VoicesTab />}
                {tab === 'settings' && <SettingsTab />}
              </>
            )}
          </View>
        </ErrorBoundary>
      </KeyboardAvoidingView>
      <SafeAreaView edges={['bottom']} style={[styles.tabBar, { borderColor: '#1F2236', backgroundColor: t.tab }]}>
        {TABS.map((item) => {
          const active = item.key === tab && !page;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{ selected: active }}
              onPress={() => {
                setPage(null);
                setTab(item.key);
              }}
              style={styles.tab}
            >
              <Icon name={item.icon} size={22} color={active ? t.accent : t.faint} />
              <Text style={{ color: active ? t.accent : t.faint, fontFamily: active ? font.bold : font.semibold, fontSize: 11 }}>{item.label}</Text>
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
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 10, paddingBottom: 8, gap: 4, minHeight: 60 },
});
