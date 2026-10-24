/**
 * Supported languages for voice generation, per engine.
 *
 * Swaram (Indian-language edition of Voicebox): English plus 11 Indian
 * languages. IndicF5 covers the 11 Indian languages, OmniVoice covers all
 * 12, Chatterbox and Kokoro add Hindi, and the remaining engines are
 * English-only.
 */

/** All languages that any engine supports. */
export const ALL_LANGUAGES = {
  en: 'English',
  hi: 'Hindi (हिन्दी)',
  te: 'Telugu (తెలుగు)',
  ta: 'Tamil (தமிழ்)',
  kn: 'Kannada (ಕನ್ನಡ)',
  ml: 'Malayalam (മലയാളം)',
  mr: 'Marathi (मराठी)',
  bn: 'Bengali (বাংলা)',
  gu: 'Gujarati (ગુજરાતી)',
  or: 'Odia (ଓଡ଼ିଆ)',
  pa: 'Punjabi (ਪੰਜਾਬੀ)',
  as: 'Assamese (অসমীয়া)',
} as const;

export type LanguageCode = keyof typeof ALL_LANGUAGES;

const INDIC_LANGUAGES: readonly LanguageCode[] = [
  'hi',
  'te',
  'ta',
  'kn',
  'ml',
  'mr',
  'bn',
  'gu',
  'or',
  'pa',
  'as',
];

/** Per-engine supported language codes. */
export const ENGINE_LANGUAGES: Record<string, readonly LanguageCode[]> = {
  qwen: ['en'],
  luxtts: ['en'],
  chatterbox: ['en', 'hi'],
  chatterbox_turbo: ['en'],
  tada: ['en'],
  kokoro: ['en', 'hi'],
  qwen_custom_voice: ['en'],
  qwen_voice_design: ['en'],
  omnivoice: ['en', ...INDIC_LANGUAGES],
  indicf5: INDIC_LANGUAGES,
} as const;

/** Helper: get language options for a given engine. */
export function getLanguageOptionsForEngine(engine: string) {
  const codes = ENGINE_LANGUAGES[engine] ?? ENGINE_LANGUAGES.qwen;
  return codes.map((code) => ({
    value: code,
    label: ALL_LANGUAGES[code],
  }));
}

// ── Backwards-compatible exports used elsewhere ──────────────────────
export const SUPPORTED_LANGUAGES = ALL_LANGUAGES;
export const LANGUAGE_CODES = Object.keys(ALL_LANGUAGES) as LanguageCode[];
export const LANGUAGE_OPTIONS = LANGUAGE_CODES.map((code) => ({
  value: code,
  label: ALL_LANGUAGES[code],
}));
