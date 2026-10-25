import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

/** One app-wide player, so starting one clip stops the previous. */
interface PlayerApi {
  playingUri: string | null;
  isPlaying: (uri: string) => boolean;
  toggle: (uri: string) => Promise<void>;
  stop: () => void;
  position: number;
  duration: number;
}

const Ctx = createContext<PlayerApi | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [uri, setUri] = useState<string | null>(null);

  const toggle = useCallback(
    async (next: string) => {
      if (uri === next) {
        if (status.playing) {
          player.pause();
          return;
        }
        if (status.duration > 0 && status.currentTime >= status.duration - 0.05) await player.seekTo(0);
        player.play();
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      player.replace({ uri: next });
      setUri(next);
      player.play();
    },
    [player, status.playing, status.duration, status.currentTime, uri],
  );

  const stop = useCallback(() => player.pause(), [player]);

  const api = useMemo<PlayerApi>(
    () => ({
      playingUri: status.playing ? uri : null,
      isPlaying: (u: string) => status.playing && u === uri,
      toggle,
      stop,
      position: status.currentTime,
      duration: status.duration,
    }),
    [status.playing, status.currentTime, status.duration, uri, toggle, stop],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function usePlayer(): PlayerApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePlayer outside PlayerProvider');
  return v;
}
