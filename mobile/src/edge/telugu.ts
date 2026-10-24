/**
 * Telugu numbers, ₹ and % spelled out the way they are spoken. Port of
 * backend/utils/indic_text.py (same rules, same tests' expected output), so
 * offline speech reads numbers the same as the server.
 */

const UNITS = ['సున్నా', 'ఒకటి', 'రెండు', 'మూడు', 'నాలుగు', 'ఐదు', 'ఆరు', 'ఏడు', 'ఎనిమిది', 'తొమ్మిది'];
const TEENS = ['పది', 'పదకొండు', 'పన్నెండు', 'పదమూడు', 'పద్నాలుగు', 'పదిహేను', 'పదహారు', 'పదిహేడు', 'పద్దెనిమిది', 'పందొమ్మిది'];
const TENS = ['', '', 'ఇరవై', 'ముప్పై', 'నలభై', 'యాభై', 'అరవై', 'డెబ్బై', 'ఎనభై', 'తొంభై'];
const SCALES: [number, string, string, string, string][] = [
  [10_000_000, 'కోటి', 'కోటి', 'కోట్లు', 'కోట్ల'],
  [100_000, 'లక్ష', 'లక్ష', 'లక్షలు', 'లక్షల'],
  [1_000, 'వెయ్యి', 'వెయ్యి', 'వేలు', 'వేల'],
];
const MAX_SPELLED = 1e12;

function below100(n: number): string {
  if (n < 10) return UNITS[n];
  if (n < 20) return TEENS[n - 10];
  const tens = Math.floor(n / 10);
  const unit = n % 10;
  return TENS[tens] + (unit === 0 ? '' : ` ${UNITS[unit]}`);
}

function below1000(n: number): string {
  if (n < 100) return below100(n);
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  let whole: string;
  let joined: string;
  if (hundreds === 1) {
    whole = 'వంద';
    joined = 'నూట';
  } else {
    const count = below100(hundreds);
    whole = `${count} వందలు`;
    joined = `${count} వందల`;
  }
  return rest === 0 ? whole : `${joined} ${below100(rest)}`;
}

export function teluguNumber(n: number): string {
  if (n < 0) return `మైనస్ ${teluguNumber(-n)}`;
  if (n < 1000) return below1000(n);
  for (const [value, oneWhole, oneJoined, manyWhole, manyJoined] of SCALES) {
    if (n >= value) {
      const count = Math.floor(n / value);
      const rest = n % value;
      const head =
        count === 1 ? (rest === 0 ? oneWhole : oneJoined) : `${teluguNumber(count)} ${rest === 0 ? manyWhole : manyJoined}`;
      return rest === 0 ? head : `${head} ${teluguNumber(rest)}`;
    }
  }
  return below1000(n);
}

const NUMBER_RE = /(^|[^A-Za-z0-9.])(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?(?![A-Za-z0-9])/g;
const RUPEE_RE = /(?:₹|Rs\.?|INR)\s?(\d[\d,]*(?:\.\d+)?)/gi;
const PERCENT_RE = /(\d[\d,]*(?:\.\d+)?)\s?%/g;

function spell(intText: string, frac: string | undefined): string {
  const digits = intText.replace(/,/g, '');
  const value = Number(digits);
  if (value >= MAX_SPELLED) return digits.split('').map((d) => UNITS[Number(d)]).join(' ');
  if (frac) return `${teluguNumber(value)} పాయింట్ ${frac.split('').map((d) => UNITS[Number(d)]).join(' ')}`;
  return teluguNumber(value);
}

/** Expand numbers for Telugu text; other languages are returned unchanged. */
export function prepareText(text: string, language: string): string {
  if (language !== 'te') return text;
  let out = text.replace(RUPEE_RE, (_m, num: string) => `${num} రూపాయలు`);
  out = out.replace(PERCENT_RE, (_m, num: string) => `${num} శాతం`);
  return out.replace(NUMBER_RE, (_m, pre: string, int: string, frac?: string) => pre + spell(int, frac));
}
