/** App preferences and small saved state (one JSON file; synchronous reads). */
import { File, Paths } from 'expo-file-system';
import type { Provider } from './engine';

import { type Pronunciation, replaceWords } from './textrules';

export type { Pronunciation };

export interface Prefs {
  steps: number;
  provider: Provider;
  speed: number;
  exportFormat: 'm4a' | 'wav';
  pronunciations: Pronunciation[];
  draft: string;
  draftTitle: string;
  /** Studio: speaker label -> voice key. */
  speakerVoices: Record<string, string>;
  defaultVoice?: string;
}

const DEFAULTS: Prefs = {
  steps: 8,
  provider: 'xnnpack',
  speed: 1,
  exportFormat: 'm4a',
  pronunciations: [],
  draft: '',
  draftTitle: '',
  speakerVoices: {},
};

function file() {
  return new File(Paths.document, 'swaram-prefs.json');
}

let cache: Prefs | null = null;

export function getPrefs(): Prefs {
  if (cache) return cache;
  try {
    const f = file();
    cache = f.exists ? { ...DEFAULTS, ...(JSON.parse(f.textSync()) as Partial<Prefs>) } : { ...DEFAULTS };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function setPrefs(patch: Partial<Prefs>): Prefs {
  cache = { ...getPrefs(), ...patch };
  try {
    file().writeSync(JSON.stringify(cache));
  } catch {
    // Preferences are a convenience; never block the app on them.
  }
  return cache;
}

/** Applies the pronunciation dictionary saved in preferences. */
export function applyPronunciations(text: string, list = getPrefs().pronunciations): string {
  return replaceWords(text, list);
}
