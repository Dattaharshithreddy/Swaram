import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';
import { SwaramEdge } from '../modules/swaram-edge';
import { getPrefs } from './edge/prefs';

function safeName(label: string) {
  return label.replace(/[^A-Za-z0-9ఀ-౿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'swaram';
}

/** The file in the chosen export format (M4A is made from the WAV on demand). */
async function inFormat(uri: string, format = getPrefs().exportFormat): Promise<{ uri: string; ext: string; mime: string }> {
  if (format === 'm4a' && uri.toLowerCase().endsWith('.wav') && SwaramEdge) {
    const out = new File(Paths.cache, `swaram-export-${Date.now()}.m4a`);
    await SwaramEdge.encodeM4a(uri, out.uri, 96000);
    return { uri: out.uri, ext: 'm4a', mime: 'audio/mp4' };
  }
  return { uri, ext: 'wav', mime: 'audio/wav' };
}

/** Saves generated audio to Downloads/Swaram and says where it went. */
export async function downloadAudio(uri: string, label = 'swaram'): Promise<void> {
  try {
    if (!SwaramEdge) throw new Error('Saving needs the latest app build.');
    const f = await inFormat(uri);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const where = await SwaramEdge.saveToDownloads(f.uri, `${safeName(label)}-${stamp}.${f.ext}`, f.mime);
    Alert.alert('Saved', `Saved to ${where}. Open it from the Files app.`);
  } catch (e) {
    Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
  }
}

export async function shareAudio(uri: string): Promise<void> {
  try {
    const f = await inFormat(uri);
    await Sharing.shareAsync(f.uri, { mimeType: f.mime, dialogTitle: 'Share audio' });
  } catch (e) {
    Alert.alert('Could not share', e instanceof Error ? e.message : String(e));
  }
}

export async function downloadSubtitles(srtUri: string, label = 'swaram'): Promise<void> {
  try {
    if (!SwaramEdge) throw new Error('Saving needs the latest app build.');
    const where = await SwaramEdge.saveToDownloads(srtUri, `${safeName(label)}.srt`, 'application/x-subrip');
    Alert.alert('Subtitles saved', `Saved to ${where}.`);
  } catch (e) {
    Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
  }
}
