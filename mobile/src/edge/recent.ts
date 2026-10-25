/** Recently made audio (single lines and finished scripts), newest first. */
import { File, Paths } from 'expo-file-system';

export interface RecentItem {
  id: string;
  uri: string;
  title: string;
  voiceName: string;
  seconds: number;
  at: number;
  srtUri?: string;
}

function file() {
  return new File(Paths.document, 'swaram-recent.json');
}

export function listRecent(): RecentItem[] {
  try {
    const f = file();
    const all = f.exists ? (JSON.parse(f.textSync()) as RecentItem[]) : [];
    return all.filter((r) => new File(r.uri).exists);
  } catch {
    return [];
  }
}

export function addRecent(item: Omit<RecentItem, 'id' | 'at'>): RecentItem {
  const r: RecentItem = { ...item, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: Date.now() };
  const list = [r, ...listRecent().filter((x) => x.uri !== item.uri)].slice(0, 50);
  file().writeSync(JSON.stringify(list));
  return r;
}

export function removeRecent(id: string) {
  file().writeSync(JSON.stringify(listRecent().filter((r) => r.id !== id)));
}

export function ago(at: number): string {
  const s = (Date.now() - at) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

export function duration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
