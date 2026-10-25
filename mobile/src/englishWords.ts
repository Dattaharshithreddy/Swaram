/**
 * English words inside Telugu speech ("Space లో satellites") → Telugu script as
 * Telugu speakers say them ("స్పేస్ లో శాటిలైట్స్"), from the generated
 * CMU-dictionary list in edge/englishTelugu.ts.
 */
import { ENGLISH_TELUGU } from './edge/englishTelugu';

type Entry = { te: string; common: boolean };
let table: Map<string, Entry> | null = null;

function dict(): Map<string, Entry> {
  if (!table) {
    table = new Map();
    for (const line of ENGLISH_TELUGU.split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const common = line[0] === '*';
      table.set(line.slice(common ? 1 : 0, tab), { te: line.slice(tab + 1), common });
    }
  }
  return table;
}

const VIRAMA = '్';
const LETTERS: Record<string, string> = {
  a: 'ఏ', b: 'బీ', c: 'సీ', d: 'డీ', e: 'ఈ', f: 'ఎఫ్', g: 'జీ', h: 'హెచ్', i: 'ఐ', j: 'జే', k: 'కే', l: 'ఎల్', m: 'ఎం',
  n: 'ఎన్', o: 'ఓ', p: 'పీ', q: 'క్యూ', r: 'ఆర్', s: 'ఎస్', t: 'టీ', u: 'యూ', v: 'వీ', w: 'డబ్ల్యూ', x: 'ఎక్స్', y: 'వై', z: 'జెడ్',
};

function withSuffix(stem: string, suffix: string): string {
  const bare = stem.endsWith(VIRAMA);
  switch (suffix) {
    case 's':
    case 'es':
      return /[సజషచ]్$/.test(stem) ? `${stem.slice(0, -1)}ెస్` : `${stem}స్`;
    case 'ed':
      return /[టడ]్$/.test(stem) ? `${stem.slice(0, -1)}ెడ్` : `${stem}డ్`;
    case 'ing':
      return bare ? `${stem.slice(0, -1)}ింగ్` : `${stem}యింగ్`;
    case 'er':
      return bare ? `${stem.slice(0, -1)}ర్` : `${stem}యర్`;
    default: // ly
      return `${stem}లీ`;
  }
}

/**
 * The Telugu spelling of an English word, or null if it isn't a known English word.
 * commonOnly: when the text has no Telugu script, rarer words may be Telugu typed in English letters.
 */
export function englishToTelugu(raw: string, commonOnly = false): string | null {
  const w = raw.toLowerCase();
  const ok = (e: Entry | undefined) => (e && (!commonOnly || e.common) ? e : undefined);
  const hit = ok(dict().get(w));
  if (hit) return hit.te;
  for (const suffix of ['ing', 'es', 'ed', 'er', 'ly', 's']) {
    if (w.length <= suffix.length + 2 || !w.endsWith(suffix)) continue;
    const stem = w.slice(0, -suffix.length);
    const e = ok(dict().get(stem)) ?? (suffix !== 's' && suffix !== 'ly' ? ok(dict().get(`${stem}e`)) : undefined);
    if (e) return withSuffix(e.te, suffix);
  }
  // Short all-capitals words are read letter by letter: ISRO is known, but CBI → సీ బీ ఐ
  if (/^[A-Z]{2,5}$/.test(raw)) return raw.toLowerCase().split('').map((c) => LETTERS[c]).join(' ');
  return null;
}
