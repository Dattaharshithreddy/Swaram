/**
 * Voices on the user's GPU server, for the main tabs (Home, Voices).
 *
 * The server is optional and often stopped (it's paid by the hour), so a
 * failed fetch just means "no server voices right now": no error is shown
 * outside the GPU server page.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type VoiceProfile } from './api';
import { useServerConfig } from './settings';

export const SERVER_PREFIX = 'server:';

export function serverKey(v: VoiceProfile): string {
  return `${SERVER_PREFIX}${v.id}`;
}

export function useServerVoices() {
  const { config, loaded } = useServerConfig();
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [reachable, setReachable] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    if (!config.url) {
      setVoices([]);
      setReachable(null);
      return;
    }
    try {
      setVoices(await api.listVoices(config));
      setReachable(true);
    } catch {
      setVoices([]);
      setReachable(false);
    }
  }, [config]);

  useEffect(() => {
    if (loaded) void refresh();
  }, [loaded, refresh]);

  return { config, voices, reachable, refresh, configured: !!config.url };
}
