/**
 * Telugu script -> phonemes for personal voice models. Same rules as
 * personal-voice/telugu_ipa.py (used for training); both are checked against
 * personal-voice/tests/golden.json, so the phone feeds the model exactly
 * what it was trained on.
 */

const CONSONANTS: Record<string, string> = {
  క: 'k', ఖ: 'kʰ', గ: 'ɡ', ఘ: 'ɡʰ', ఙ: 'ŋ',
  చ: 'c', ఛ: 'cʰ', జ: 'ɟ', ఝ: 'ɟʰ', ఞ: 'ɲ',
  ట: 'ʈ', ఠ: 'ʈʰ', డ: 'ɖ', ఢ: 'ɖʰ', ణ: 'ɳ',
  త: 't', థ: 'tʰ', ద: 'd', ధ: 'dʰ', న: 'n',
  ప: 'p', ఫ: 'pʰ', బ: 'b', భ: 'bʰ', మ: 'm',
  య: 'j', ర: 'r', ఱ: 'r', ల: 'l', వ: 'ʋ',
  శ: 'ɕ', ష: 'ʂ', స: 's', హ: 'h', ళ: 'ɭ',
};
const VOWELS: [string, string, string | null][] = [
  ['అ', 'a', null], ['ఆ', 'aː', 'ా'], ['ఇ', 'i', 'ి'], ['ఈ', 'iː', 'ీ'],
  ['ఉ', 'u', 'ు'], ['ఊ', 'uː', 'ూ'], ['ఋ', 'ru', 'ృ'], ['ౠ', 'ruː', 'ౄ'],
  ['ఎ', 'e', 'ె'], ['ఏ', 'eː', 'ే'], ['ఐ', 'aɪ', 'ై'],
  ['ఒ', 'o', 'ొ'], ['ఓ', 'oː', 'ో'], ['ఔ', 'aʊ', 'ౌ'],
];
const SIGNS: Record<string, string> = Object.fromEntries(VOWELS.filter((v) => v[2]).map((v) => [v[2] as string, v[1]]));
const INDEPENDENT: Record<string, string> = Object.fromEntries(VOWELS.map((v) => [v[0], v[1]]));
const VIRAMA = '్';
const ANUSVARA = 'ం';
const VISARGA = 'ః';
const PUNCT: Record<string, string> = { ',': ',', '.': '.', '?': '?', '!': '!', ';': ';', ':': ':', '।': '.', '॥': '.', '-': ' ' };
const STRESS = 'ˈ';

function word(w: string): string {
  const out: string[] = [];
  const chars = Array.from(w);
  let stressed = false;
  const vowel = (ipa: string) => {
    if (!stressed) {
      out.push(STRESS);
      stressed = true;
    }
    out.push(ipa);
  };
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === 'జ' && chars[i + 1] === VIRAMA && chars[i + 2] === 'ఞ') {
      out.push('ɡn');
      i += 3;
      const nxt = chars[i] ?? '';
      if (SIGNS[nxt]) {
        vowel(SIGNS[nxt]);
        i++;
      } else if (nxt === VIRAMA) i++;
      else vowel('a');
      continue;
    }
    if (CONSONANTS[ch]) {
      out.push(CONSONANTS[ch]);
      const nxt = chars[i + 1] ?? '';
      if (nxt === VIRAMA) i += 2;
      else if (SIGNS[nxt]) {
        if (nxt === 'ృ' || nxt === 'ౄ') {
          out.push('r');
          vowel(SIGNS[nxt].slice(1));
        } else vowel(SIGNS[nxt]);
        i += 2;
      } else {
        vowel('a');
        i++;
      }
    } else if (INDEPENDENT[ch]) {
      if (ch === 'ఋ' || ch === 'ౠ') {
        out.push('r');
        vowel(INDEPENDENT[ch].slice(1));
      } else vowel(INDEPENDENT[ch]);
      i++;
    } else if (ch === ANUSVARA) {
      out.push('n');
      i++;
    } else if (ch === VISARGA) {
      out.push('h');
      i++;
    } else i++;
  }
  return out.join('');
}

export function teluguPhonemes(text: string): string {
  const out: string[] = [];
  const tokens = text.normalize('NFC').match(/[ఀ-౿‌‍]+|[,.?!;:।॥-]|\s+/g) ?? [];
  for (const tok of tokens) {
    if (/^\s+$/.test(tok)) {
      if (out.length && out[out.length - 1] !== ' ') out.push(' ');
    } else if (PUNCT[tok] !== undefined) {
      while (out.length && out[out.length - 1] === ' ') out.pop();
      const p = PUNCT[tok];
      out.push(p);
      if (p !== ' ') out.push(' ');
    } else out.push(word(tok));
  }
  return out.join('').trim();
}
