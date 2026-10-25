/**
 * Telugu typed in English letters ("na peru datta") → Telugu script
 * ("నా పేరు దత్త"), because the voice model reads Telugu script only.
 *
 * Common words come from a small dictionary (casual spelling doesn't mark
 * long vowels or ట/త, so rules alone get them wrong); everything else goes
 * through phonetic rules close to how people type Telugu on WhatsApp:
 * aa/ee/oo are long vowels, th/dh/t/d are త/ద, capital T/D/N/L are ట/డ/ణ/ళ,
 * sh is శ. The screens show the result so it can be corrected before speaking.
 */

import { englishToTelugu } from './englishWords';

const WORDS: Record<string, string> = {
  // People and greetings
  hi: 'హాయ్', hello: 'హలో', hai: 'హాయ్', bye: 'బై', ok: 'ఓకే', okay: 'ఓకే', sorry: 'సారీ', please: 'ప్లీజ్',
  thanks: 'థాంక్స్', thank: 'థాంక్', you: 'యూ', namaskaram: 'నమస్కారం', namaste: 'నమస్తే',
  dhanyavadalu: 'ధన్యవాదాలు', dhanyavaadalu: 'ధన్యవాదాలు',
  amma: 'అమ్మ', nanna: 'నాన్న', anna: 'అన్న', akka: 'అక్క', thammudu: 'తమ్ముడు', tammudu: 'తమ్ముడు',
  chelli: 'చెల్లి', babu: 'బాబు', papa: 'పాప', thatha: 'తాత', tata: 'తాత', ammamma: 'అమ్మమ్మ', nanamma: 'నానమ్మ',
  friend: 'ఫ్రెండ్', friends: 'ఫ్రెండ్స్',
  // Pronouns and possessives
  nenu: 'నేను', naa: 'నా', na: 'నా', naku: 'నాకు', naaku: 'నాకు', nannu: 'నన్ను', memu: 'మేము', manam: 'మనం',
  nuvvu: 'నువ్వు', nuvu: 'నువ్వు', neeku: 'నీకు', niku: 'నీకు', nee: 'నీ', ni: 'నీ', ninnu: 'నిన్ను',
  meeru: 'మీరు', miru: 'మీరు', mee: 'మీ', mi: 'మీ', meeku: 'మీకు', miku: 'మీకు', maa: 'మా', ma: 'మా', maaku: 'మాకు',
  makuu: 'మాకు', maku: 'మాకు', manaku: 'మనకు', atanu: 'అతను', aame: 'ఆమె', ame: 'ఆమె', vaallu: 'వాళ్ళు',
  vallu: 'వాళ్ళు', vaadu: 'వాడు', vadu: 'వాడు', adi: 'అది', idi: 'ఇది', avi: 'అవి', ivi: 'ఇవి',
  // Questions
  emi: 'ఏమి', em: 'ఏం', enti: 'ఏంటి', yenti: 'ఏంటి', ela: 'ఎలా', yela: 'ఎలా', ekkada: 'ఎక్కడ', yekkada: 'ఎక్కడ',
  eppudu: 'ఎప్పుడు', yeppudu: 'ఎప్పుడు', enduku: 'ఎందుకు', yenduku: 'ఎందుకు', evaru: 'ఎవరు', yevaru: 'ఎవరు',
  entha: 'ఎంత', yentha: 'ఎంత', enta: 'ఎంత', ye: 'ఏ', ee: 'ఈ', aa: 'ఆ',
  // Common verbs and words
  peru: 'పేరు', unnanu: 'ఉన్నాను', unnaru: 'ఉన్నారు', unnavu: 'ఉన్నావు', unnav: 'ఉన్నావ్',
  unnara: 'ఉన్నారా', unnava: 'ఉన్నావా', undi: 'ఉంది', unnadi: 'ఉన్నది', bagunnanu: 'బాగున్నాను', baagunnanu: 'బాగున్నాను',
  bagunnara: 'బాగున్నారా', bagunnava: 'బాగున్నావా', bagundi: 'బాగుంది', baagundi: 'బాగుంది', bagunna: 'బాగున్నా',
  baga: 'బాగా', baaga: 'బాగా', chala: 'చాలా', chaala: 'చాలా', manchi: 'మంచి', pedda: 'పెద్ద', chinna: 'చిన్న',
  ledu: 'లేదు', ledhu: 'లేదు', kaadu: 'కాదు', kadu: 'కాదు', avunu: 'అవును', haa: 'హా', sare: 'సరే', saare: 'సరే',
  ikkada: 'ఇక్కడ', akkada: 'అక్కడ', ippudu: 'ఇప్పుడు', appudu: 'అప్పుడు', ivala: 'ఇవాళ', ivvala: 'ఇవ్వాళ',
  repu: 'రేపు', reepu: 'రేపు', ninna: 'నిన్న', roju: 'రోజు', rojulu: 'రోజులు', time: 'టైమ్', pani: 'పని',
  illu: 'ఇల్లు', intiki: 'ఇంటికి', inti: 'ఇంటి', office: 'ఆఫీస్', school: 'స్కూల్', college: 'కాలేజ్',
  randi: 'రండి', ra: 'రా', raa: 'రా', po: 'పో', vellu: 'వెళ్ళు', velli: 'వెళ్ళి', veltanu: 'వెళ్తాను',
  veltunna: 'వెళ్తున్నా', vachanu: 'వచ్చాను', vacchanu: 'వచ్చాను', vastanu: 'వస్తాను', vasthanu: 'వస్తాను',
  vachi: 'వచ్చి', cheppu: 'చెప్పు', cheppandi: 'చెప్పండి', cheppanu: 'చెప్పాను', chestanu: 'చేస్తాను',
  chesthanu: 'చేస్తాను', chestunna: 'చేస్తున్నా', chesthunna: 'చేస్తున్నా', chesanu: 'చేశాను', chey: 'చెయ్',
  cheyandi: 'చేయండి', tinnava: 'తిన్నావా', tinnara: 'తిన్నారా', tinnanu: 'తిన్నాను', tindi: 'తిండి',
  annam: 'అన్నం', neellu: 'నీళ్ళు', nillu: 'నీళ్ళు', matladu: 'మాట్లాడు', matladandi: 'మాట్లాడండి',
  matladutanu: 'మాట్లాడుతాను', maata: 'మాట', mata: 'మాట', telugu: 'తెలుగు', telusu: 'తెలుసు',
  teliyadu: 'తెలియదు', kavali: 'కావాలి', kaavali: 'కావాలి', vaddu: 'వద్దు', istam: 'ఇష్టం', ishtam: 'ఇష్టం',
  prema: 'ప్రేమ', santosham: 'సంతోషం', baadha: 'బాధ', badha: 'బాధ', bhayam: 'భయం', dabbulu: 'డబ్బులు',
  dabbu: 'డబ్బు', rupayalu: 'రూపాయలు', ooru: 'ఊరు', uru: 'ఊరు', desam: 'దేశం', bhasha: 'భాష', video: 'వీడియో',
  channel: 'ఛానల్', subscribe: 'సబ్స్క్రైబ్', like: 'లైక్', share: 'షేర్', andaru: 'అందరు', andariki: 'అందరికీ',
  andi: 'అండి', garu: 'గారు', gaaru: 'గారు', kuda: 'కూడా', kooda: 'కూడా', inka: 'ఇంకా', mari: 'మరి',
  kani: 'కానీ', kaani: 'కానీ', ante: 'అంటే', mundu: 'ముందు', taruvata: 'తరువాత', tarvata: 'తర్వాత',
  modati: 'మొదటి', okka: 'ఒక్క', oka: 'ఒక', okati: 'ఒకటి', rendu: 'రెండు', moodu: 'మూడు', nalugu: 'నాలుగు',
  hyderabad: 'హైదరాబాద్', vizag: 'వైజాగ్', bangalore: 'బెంగళూరు', bengaluru: 'బెంగళూరు', chennai: 'చెన్నై',
  vijayawada: 'విజయవాడ', guntur: 'గుంటూరు', tirupati: 'తిరుపతి', warangal: 'వరంగల్', india: 'ఇండియా',
  bharat: 'భారత్', andhra: 'ఆంధ్ర', telangana: 'తెలంగాణ', pradesh: 'ప్రదేశ్',
  mana: 'మన', ani: 'అని', antaru: 'అంటారు', antunnaru: 'అంటున్నారు',
  // Particles and endings that are also English dictionary words
  lo: 'లో', ki: 'కి', ku: 'కు', nu: 'ను', ga: 'గా', tho: 'తో', tha: 'త', kosam: 'కోసం', gurinchi: 'గురించి',
  kada: 'కదా', kadha: 'కదా', ayindi: 'అయింది', ayyindi: 'అయ్యింది', emo: 'ఏమో', untundi: 'ఉంటుంది',
  untayi: 'ఉంటాయి', vachindi: 'వచ్చింది', poyindi: 'పోయింది', chusi: 'చూసి', chudandi: 'చూడండి',
  vinandi: 'వినండి', cheptha: 'చెప్తా', chepta: 'చెప్తా', anni: 'అన్ని', antha: 'అంత', intha: 'ఇంత',
  vere: 'వేరే', ide: 'ఇదే', ade: 'అదే', ala: 'అలా', ila: 'ఇలా', aithe: 'అయితే', ayithe: 'అయితే',
};

type Unit = { key: string; cons?: string; indep?: string; matra?: string };

// Longest keys first. Case matters only for the ITRANS-style capitals.
const CONSONANTS: [string, string][] = [
  ['ksh', 'క్ష'], ['chh', 'ఛ'], ['shh', 'ష'], ['jn', 'జ్ఞ'],
  ['kh', 'ఖ'], ['gh', 'ఘ'], ['ch', 'చ'], ['jh', 'ఝ'], ['Th', 'ఠ'], ['Dh', 'ఢ'], ['th', 'త'], ['dh', 'ద'],
  ['ph', 'ఫ'], ['bh', 'భ'], ['Sh', 'ష'], ['sh', 'శ'],
  ['k', 'క'], ['g', 'గ'], ['c', 'క'], ['j', 'జ'], ['T', 'ట'], ['D', 'డ'], ['N', 'ణ'], ['t', 'త'], ['d', 'ద'],
  ['n', 'న'], ['p', 'ప'], ['f', 'ఫ'], ['b', 'బ'], ['m', 'మ'], ['y', 'య'], ['r', 'ర'], ['L', 'ళ'], ['l', 'ల'],
  ['v', 'వ'], ['w', 'వ'], ['S', 'ష'], ['s', 'స'], ['h', 'హ'], ['z', 'జ'], ['x', 'క్స'], ['q', 'క'],
];
const VOWELS: [string, string, string][] = [
  // key, independent, matra ('' = inherent a)
  ['aa', 'ఆ', 'ా'], ['ai', 'ఐ', 'ై'], ['au', 'ఔ', 'ౌ'], ['ou', 'ఔ', 'ౌ'], ['ee', 'ఈ', 'ీ'], ['ii', 'ఈ', 'ీ'],
  ['oo', 'ఊ', 'ూ'], ['uu', 'ఊ', 'ూ'], ['A', 'ఆ', 'ా'], ['I', 'ఈ', 'ీ'], ['U', 'ఊ', 'ూ'], ['E', 'ఏ', 'ే'],
  ['O', 'ఓ', 'ో'], ['a', 'అ', ''], ['i', 'ఇ', 'ి'], ['u', 'ఉ', 'ు'], ['e', 'ఎ', 'ె'], ['o', 'ఒ', 'ొ'],
];
const VIRAMA = '్';
const ANUSVARA = 'ం';
// n/m before these stay full consonants (amma, anna, nanna, sanyasi); before others they become ం.
const NO_ANUSVARA_BEFORE = new Set(['న', 'మ', 'య', 'ర', 'ల', 'వ', 'హ', 'ళ']);

function units(word: string): Unit[] {
  const out: Unit[] = [];
  let i = 0;
  outer: while (i < word.length) {
    for (const [k, indep, matra] of VOWELS) {
      if (word.startsWith(k, i)) {
        out.push({ key: k, indep, matra });
        i += k.length;
        continue outer;
      }
    }
    for (const [k, cons] of CONSONANTS) {
      if (word.startsWith(k, i)) {
        out.push({ key: k, cons });
        i += k.length;
        continue outer;
      }
    }
    out.push({ key: word[i] }); // anything else passes through
    i++;
  }
  return out;
}

function ruleWord(word: string): string {
  const us = units(word);
  let out = '';
  let afterConsonant = false; // last thing written was a bare consonant
  for (let i = 0; i < us.length; i++) {
    const u = us[i];
    const next = us[i + 1];
    if (u.cons) {
      const nasal = u.key === 'n' || u.key === 'm';
      if (nasal && i > 0 && next?.cons && !NO_ANUSVARA_BEFORE.has(next.cons)) {
        out += ANUSVARA; // andaru → అందరు, manchi → మంచి
        afterConsonant = false;
      } else if (u.key === 'm' && i > 0 && !next) {
        out += ANUSVARA; // final m: manam → మనం
        afterConsonant = false;
      } else if (u.key === 'y' && afterConsonant && next?.indep === undefined) {
        // y between consonants or at the end sounds like "ai": my → మై
        out = out.slice(0, -VIRAMA.length) + 'ై';
        afterConsonant = false;
      } else {
        out += u.cons;
        if (next?.indep === undefined) out += VIRAMA; // cluster or word end
        afterConsonant = true;
      }
    } else if (u.indep !== undefined) {
      out += afterConsonant ? u.matra : u.indep;
      afterConsonant = false;
    } else {
      out += u.key;
      afterConsonant = false;
    }
  }
  return out;
}

function normaliseCase(word: string): string {
  // Sentence case and ALL CAPS are just how people type; only capitals
  // inside a word (maaTa, kaLa) mean retroflex letters.
  if (word === word.toUpperCase() || /^[A-Z][a-z]*$/.test(word)) return word.toLowerCase();
  return word;
}

/**
 * When the text already has Telugu script, English-letter words are English
 * ("Space లో satellites") and are spelled as Telugu speakers say them. In
 * all-English-letter text they're usually Telugu typed in English, so only
 * common English words are treated as English there.
 */
export function romanToTelugu(text: string): string {
  const mixed = /[\u0C00-\u0C7F]/.test(text);
  return text.replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, (raw) => {
    const known = WORDS[raw.toLowerCase()];
    if (known) return known;
    const english = englishToTelugu(raw.replace(/'/g, ''), !mixed);
    if (english) return english;
    return ruleWord(normaliseCase(raw.replace(/'/g, '')));
  });
}

export function hasLatin(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

/** What the voice will actually read: Telugu typed in English letters is converted. */
export function spokenText(text: string, language: string | undefined): string {
  return language === 'te' && hasLatin(text) ? romanToTelugu(text) : text;
}
