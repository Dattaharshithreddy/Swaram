import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useState } from 'react';
import type { ServerConfig } from './api';

const URL_KEY = 'swaram.serverUrl';
const API_KEY = 'swaram.apiKey';

/** Server URL and API key, kept in the phone's encrypted storage. */
export function useServerConfig() {
  const [config, setConfig] = useState<ServerConfig>({ url: '', apiKey: '' });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const [url, apiKey] = await Promise.all([
        SecureStore.getItemAsync(URL_KEY).catch(() => null),
        SecureStore.getItemAsync(API_KEY).catch(() => null),
      ]);
      setConfig({ url: url ?? '', apiKey: apiKey ?? '' });
      setLoaded(true);
    })();
  }, []);

  const save = useCallback(async (next: ServerConfig) => {
    const clean = { url: next.url.trim().replace(/\/+$/, ''), apiKey: next.apiKey.trim() };
    await SecureStore.setItemAsync(URL_KEY, clean.url);
    await SecureStore.setItemAsync(API_KEY, clean.apiKey);
    setConfig(clean);
    return clean;
  }, []);

  return { config, loaded, save };
}
