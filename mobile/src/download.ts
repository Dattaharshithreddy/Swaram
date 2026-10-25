import { Alert } from 'react-native';
import { SwaramEdge } from '../modules/swaram-edge';

/** Saves generated audio to Downloads/Swaram and says where it went. */
export async function downloadAudio(uri: string, label = 'swaram'): Promise<void> {
  try {
    if (!SwaramEdge) throw new Error('Saving needs the latest app build.');
    const safe = label.replace(/[^A-Za-z0-9ఀ-౿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'swaram';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const ext = uri.toLowerCase().endsWith('.mp3') ? 'mp3' : 'wav';
    const where = await SwaramEdge.saveToDownloads(uri, `${safe}-${stamp}.${ext}`, ext === 'mp3' ? 'audio/mpeg' : 'audio/wav');
    Alert.alert('Saved', `Saved to ${where}. Open it from the Files app.`);
  } catch (e) {
    Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
  }
}
