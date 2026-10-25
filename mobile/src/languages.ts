/** Languages the Swaram server speaks, with what to show and what to read aloud. */

export type LanguageCode = 'en' | 'hi' | 'te' | 'ta' | 'kn' | 'ml' | 'mr' | 'bn' | 'gu' | 'or' | 'pa' | 'as';

export interface Language {
  code: LanguageCode;
  name: string;
  native: string;
  /** A sentence to read when recording a voice sample (5-12 seconds). */
  readAloud: string;
  /** Example text for the Speak box. */
  example: string;
}

export const LANGUAGES: Language[] = [
  {
    code: 'te',
    name: 'Telugu',
    native: 'తెలుగు',
    readAloud: 'నమస్కారం, నా పేరు మీకు చెప్తాను. ఈ రోజు వాతావరణం చాలా బాగుంది, అందుకే నేను బయట నడవడానికి వెళ్తున్నాను.',
    example: 'నమస్కారం! ఈ వీడియోలో ఎస్ఐపీ ఎలా పని చేస్తుందో ఒక్కసారి చూద్దాం.',
  },
  {
    code: 'hi',
    name: 'Hindi',
    native: 'हिन्दी',
    readAloud: 'नमस्ते, मैं आपको अपना नाम बताता हूँ। आज मौसम बहुत अच्छा है, इसलिए मैं बाहर टहलने जा रहा हूँ।',
    example: 'नमस्ते! इस वीडियो में हम देखेंगे कि SIP कैसे काम करता है।',
  },
  {
    code: 'en',
    name: 'English',
    native: 'English',
    readAloud: 'Hello, let me tell you my name. The weather is lovely today, so I am heading out for a short walk.',
    example: "Hi everyone! In this video, let's see how a SIP actually works.",
  },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்', readAloud: '', example: '' },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ', readAloud: '', example: '' },
  { code: 'ml', name: 'Malayalam', native: 'മലയാളം', readAloud: '', example: '' },
  { code: 'mr', name: 'Marathi', native: 'मराठी', readAloud: '', example: '' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', readAloud: '', example: '' },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી', readAloud: '', example: '' },
  { code: 'or', name: 'Odia', native: 'ଓଡ଼ିଆ', readAloud: '', example: '' },
  { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ', readAloud: '', example: '' },
  { code: 'as', name: 'Assamese', native: 'অসমীয়া', readAloud: '', example: '' },
];

export function languageByCode(code: string | undefined): Language | undefined {
  return LANGUAGES.find((l) => l.code === code);
}

/**
 * Cloning engine to use for a new voice. IndicF5 covers the Indian languages
 * (MIT licence, fine for paid work); Chatterbox clones English.
 */
export function engineFor(code: LanguageCode): string {
  return code === 'en' ? 'chatterbox' : 'indicf5';
}

/** Whisper has no Odia model, so Odia transcripts must be typed. */
export function canTranscribe(code: LanguageCode): boolean {
  return code !== 'or';
}
