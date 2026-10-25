import * as DocumentPicker from 'expo-document-picker';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SwaramEdge } from '../../modules/swaram-edge';
import { Body, Button, Chip, Field, Label, Notice } from '../components/ui';
import { encodeWav, SAMPLE_RATE } from '../edge/dsp';
import { readFloats } from '../edge/engine';
import { space } from '../theme';

const MAX_FILE_SECONDS = 600;
const LENGTHS = [5, 6, 8, 10];

/**
 * Pick an existing recording (voice note, video audio, any format Android
 * plays), choose a 5-10 s part with one speaker, and hand it on as a clip.
 */
export function UploadClip({ onClip }: { onClip: (clip: Float32Array | null) => void }) {
  const [audio, setAudio] = useState<Float32Array | null>(null);
  const [fileName, setFileName] = useState('');
  const [start, setStart] = useState('0');
  const [length, setLength] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const player = useAudioPlayer(null);

  const duration = audio ? audio.length / SAMPLE_RATE : 0;
  const startSec = Math.max(0, Math.min(Number.parseFloat(start.replace(',', '.')) || 0, Math.max(0, duration - 1)));
  const clip = useMemo(() => {
    if (!audio) return null;
    const a = Math.floor(startSec * SAMPLE_RATE);
    return audio.slice(a, Math.min(audio.length, a + length * SAMPLE_RATE));
  }, [audio, startSec, length]);

  useEffect(() => onClip(clip), [clip, onClip]);

  async function pick() {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({ type: ['audio/*', 'video/*'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    if (!SwaramEdge) {
      setError('This app build has no offline engine.');
      return;
    }
    setBusy(true);
    try {
      const out = new File(Paths.cache, 'swaram-upload.f32');
      if (out.exists) out.delete();
      const n = await SwaramEdge.decodeAudio(asset.uri, out.uri, MAX_FILE_SECONDS);
      if (n < SAMPLE_RATE * 3) throw new Error('This recording is shorter than 3 seconds. Use one with at least 5 seconds of speech.');
      setAudio(await readFloats(out));
      setFileName(asset.name);
      setStart('0');
      setLength(n / SAMPLE_RATE >= 8 ? 8 : 5);
      out.delete();
    } catch (e) {
      setAudio(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    if (!clip) return;
    const f = new File(Paths.cache, `swaram-preview-${Date.now()}.wav`);
    f.writeSync(encodeWav(clip));
    await setAudioModeAsync({ playsInSilentMode: true });
    player.replace({ uri: f.uri });
    player.play();
  }

  return (
    <View style={{ gap: space.md }}>
      <Body muted>
        Use a WhatsApp voice note, a recording or a video. Pick a part where only this person speaks clearly, with no
        music, then type exactly what they say in that part.
      </Body>
      <Button title={audio ? 'Choose a different file' : 'Choose audio file'} kind={audio ? 'secondary' : 'primary'} onPress={pick} busy={busy} />
      {audio && (
        <>
          <Notice text={`${fileName}: ${duration.toFixed(1)} s${duration >= MAX_FILE_SECONDS ? ' (first 10 minutes)' : ''}`} kind="ok" />
          <Field
            label={`Start at (seconds, 0-${Math.max(0, duration - 1).toFixed(0)})`}
            value={start}
            onChangeText={setStart}
            keyboardType="decimal-pad"
          />
          <Label>Length of the part</Label>
          <View style={styles.wrap}>
            {LENGTHS.map((l) => (
              <Chip key={l} label={`${l} s`} selected={length === l} onPress={() => setLength(l)} />
            ))}
          </View>
          <Notice text={`Using ${startSec.toFixed(1)}-${(startSec + (clip?.length ?? 0) / SAMPLE_RATE).toFixed(1)} s`} />
          <Button title="Play this part" kind="secondary" onPress={preview} />
        </>
      )}
      {error && <Notice text={error} kind="error" />}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
