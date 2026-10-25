import { useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { deleteStudio, downloadStudio, type StudioDownload, studioInstalled } from '../edge/store';
import { friendlyError } from '../errors';
import { useApp } from '../state';
import { font, space, useTheme } from '../theme';
import { Button, Chip, Notice, ProgressBar } from './ui';

/** Download and switch for Studio quality (full-precision model, 32 steps). */
export function StudioQuality() {
  const t = useTheme();
  const app = useApp();
  const [installed, setInstalled] = useState(studioInstalled);
  const [progress, setProgress] = useState<{ bytes: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const signal = useRef<StudioDownload>({ cancelled: false });

  async function download() {
    setError(null);
    signal.current = { cancelled: false };
    setProgress({ bytes: 0, total: 0 });
    setStatus('Connecting…');
    try {
      await downloadStudio((bytes, total) => setProgress({ bytes, total }), signal.current, setStatus);
      setInstalled(true);
      app.updatePrefs({ studio: true });
      await app.releaseEngine();
    } catch (e) {
      if (!signal.current.cancelled) setError(friendlyError(e, 'download'));
    } finally {
      setProgress(null);
    }
  }

  async function use(on: boolean) {
    app.updatePrefs({ studio: on });
    await app.releaseEngine();
  }

  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ color: t.ink, fontFamily: font.semibold, fontSize: 14 }}>Studio quality</Text>
      <Notice text="The full, uncompressed model at maximum steps: the cleanest offline voice. About 3-4 times slower per line, and needs a phone with 6 GB RAM or more." />
      {installed ? (
        <>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Chip label="Studio quality on" selected={app.prefs.studio} onPress={() => void use(true)} />
            <Chip label="Off" selected={!app.prefs.studio} onPress={() => void use(false)} />
          </View>
          <Text
            style={{ color: t.soft, fontFamily: font.semibold, fontSize: 13 }}
            onPress={() =>
              Alert.alert('Remove Studio quality?', 'Frees about 1.3 GB. Normal quality keeps working.', [
                { text: 'Keep' },
                {
                  text: 'Remove',
                  style: 'destructive',
                  onPress: async () => {
                    deleteStudio();
                    setInstalled(false);
                    await use(false);
                  },
                },
              ])
            }
          >
            Remove Studio quality (frees 1.3 GB)
          </Text>
        </>
      ) : progress ? (
        <>
          <ProgressBar value={progress.bytes / Math.max(1, progress.total)} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: t.soft, fontFamily: font.medium, fontSize: 12, flex: 1 }}>
              {progress.total ? `${status} ${(progress.bytes / 1e6).toFixed(0)} of ${(progress.total / 1e6).toFixed(0)} MB` : status}
            </Text>
            <Button
              title="Cancel"
              kind="ghost"
              small
              onPress={() => {
                signal.current.cancelled = true;
                signal.current.cancel?.();
                setProgress(null);
              }}
            />
          </View>
        </>
      ) : (
        <Button title="Download Studio quality (1.3 GB, Wi-Fi)" icon="download-cloud" kind="secondary" disabled={!app.installed} onPress={download} />
      )}
      {error && <Notice text={error} kind="error" />}
    </View>
  );
}
