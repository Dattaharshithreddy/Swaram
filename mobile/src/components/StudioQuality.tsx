import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { deleteStudio, studioInstalled } from '../edge/store';
import { useApp } from '../state';
import { font, space, useTheme } from '../theme';
import { Button, Chip, Notice, ProgressBar } from './ui';

/** Download and switch for Studio quality (full-precision model, 32 steps). The download runs app-wide. */
export function StudioQuality() {
  const t = useTheme();
  const app = useApp();
  const dl = app.downloads.studio;
  const [removed, setRemoved] = useState(false);
  const installed = !removed && !dl?.running && studioInstalled();

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
                    setRemoved(true);
                    await use(false);
                  },
                },
              ])
            }
          >
            Remove Studio quality (frees 1.3 GB)
          </Text>
        </>
      ) : dl?.running ? (
        <>
          <ProgressBar value={dl.total ? dl.bytes / dl.total : 0} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm }}>
            <Text style={{ color: t.soft, fontFamily: font.medium, fontSize: 12, flex: 1 }}>
              {dl.total ? `${dl.status} ${(dl.bytes / 1e6).toFixed(0)} of ${(dl.total / 1e6).toFixed(0)} MB` : dl.status}
            </Text>
            <Button title="Cancel" kind="ghost" small onPress={() => app.cancelDownload('studio')} />
          </View>
          <Text style={{ color: t.faint, fontFamily: font.regular, fontSize: 12 }}>
            Keeps going if you switch screens or leave the app; progress shows in the notification.
          </Text>
        </>
      ) : (
        <Button
          title="Download Studio quality (1.3 GB, Wi-Fi)"
          icon="download-cloud"
          kind="secondary"
          disabled={!app.installed}
          onPress={() => {
            setRemoved(false);
            void app.startDownload('studio');
          }}
        />
      )}
      {dl?.error && <Notice text={`${dl.error} Finished parts are kept: tap Download to continue.`} kind="error" />}
    </View>
  );
}
