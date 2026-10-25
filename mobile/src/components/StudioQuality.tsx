import { useState } from 'react';
import { Text, View } from 'react-native';
import { deleteStudio, studioInstalled } from '../edge/store';
import { useApp } from '../state';
import { font, space, useTheme } from '../theme';
import { Button, Notice } from './ui';

/**
 * Studio quality on the phone was retired: the full-precision model took about
 * 15 minutes per line on an 8 GB phone and Android closed the app for memory.
 * Only lets people free the space if they downloaded it.
 */
export function StudioQuality() {
  const t = useTheme();
  const app = useApp();
  const [has, setHas] = useState(studioInstalled);
  const partial = app.downloads.studio;
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ color: t.ink, fontFamily: font.semibold, fontSize: 14 }}>Best quality</Text>
      <Notice text="For the cleanest voice, open a project in Studio and tap Studio render on Kaggle: the full model on a free GPU, about 10-20 minutes for a whole script. (The phone-only Studio quality was too slow: about 15 minutes per line.)" />
      {(has || partial) && (
        <Button
          title="Delete the Studio quality download (frees 1.3 GB)"
          icon="trash-2"
          kind="secondary"
          small
          onPress={async () => {
            app.cancelDownload('studio');
            deleteStudio();
            setHas(false);
            app.updatePrefs({ studio: false });
            await app.releaseEngine();
          }}
        />
      )}
    </View>
  );
}
