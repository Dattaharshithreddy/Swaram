/** Pure text rules (no app imports, so tests run in Node). */

export interface Pronunciation {
  from: string;
  to: string;
}

const WORD = 'A-Za-z0-9\\u0900-\\u0DFF';

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces whole words (case-insensitive for Latin). */
export function replaceWords(text: string, list: Pronunciation[]): string {
  let out = text;
  for (const p of list) {
    if (!p.from.trim()) continue;
    // Word boundaries for Latin and the Indic scripts (no \p{} classes: not every JS engine has them).
    const re = new RegExp(`(^|[^${WORD}])${escapeRegExp(p.from.trim())}(?=$|[^${WORD}])`, 'gi');
    out = out.replace(re, (_m, pre: string) => `${pre}${p.to}`);
  }
  return out;
}
