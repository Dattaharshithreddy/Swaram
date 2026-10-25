/**
 * Emotions for voice-overs. The big model copies the tone of the recording
 * it is given, so each voice can have an extra short recording per emotion;
 * a line tagged with that emotion uses it. Without one, speed, loudness and
 * pauses are adjusted instead. Pure module (no app imports): tested in Node.
 */

export const EMOTIONS = [
  'happy',
  'sad',
  'angry',
  'excited',
  'calm',
  'whisper',
  'fearful',
  'surprised',
  'romantic',
  'crying',
  'laughing',
  'shouting',
  'serious',
  'tired',
  'nervous',
  'proud',
  'sarcastic',
  'disgusted',
] as const;
export type Emotion = (typeof EMOTIONS)[number];

interface Info {
  label: string;
  telugu: string;
  /** "Read this happily". */
  how: string;
  read: string;
  hint: string;
}

export const EMOTION_INFO: Record<Emotion, Info> = {
  happy: { label: 'Happy', telugu: 'సంతోషం', how: 'happily', read: 'అబ్బా, ఎంత మంచి వార్త! నాకు చాలా సంతోషంగా ఉంది.', hint: 'Smile while you read, light and warm.' },
  sad: { label: 'Sad', telugu: 'బాధ', how: 'sadly', read: 'ఇలా జరుగుతుందని అనుకోలేదు. మనసంతా బరువుగా ఉంది.', hint: 'Slow and soft, as if holding back tears.' },
  angry: { label: 'Angry', telugu: 'కోపం', how: 'angrily', read: 'ఎన్నిసార్లు చెప్పాలి? ఇది అస్సలు సరైన పని కాదు!', hint: 'Firm and sharp, louder than usual.' },
  excited: { label: 'Excited', telugu: 'ఉత్సాహం', how: 'excitedly', read: 'వావ్! ఇది నమ్మలేకపోతున్నా, మనం గెలిచాం!', hint: 'Fast and energetic, big ups and downs.' },
  calm: { label: 'Calm', telugu: 'ప్రశాంతం', how: 'calmly', read: 'ఏమీ కంగారు పడకు. నెమ్మదిగా ఊపిరి తీసుకో, అంతా బాగుంటుంది.', hint: 'Slow, low and gentle.' },
  whisper: { label: 'Whisper', telugu: 'గుసగుస', how: 'in a whisper', read: 'ష్... ఎవరికీ చెప్పకు, ఇది మన రహస్యం.', hint: 'Whisper close to the phone, in a quiet room.' },
  fearful: { label: 'Fearful', telugu: 'భయం', how: 'fearfully', read: 'అక్కడ ఎవరో ఉన్నారు... నాకు చాలా భయంగా ఉంది.', hint: 'Shaky and breathy, a little fast.' },
  surprised: { label: 'Surprised', telugu: 'ఆశ్చర్యం', how: 'with surprise', read: 'ఏంటి? నిజంగానా? నేను అస్సలు ఊహించలేదు!', hint: 'Rising pitch, wide-eyed.' },
  romantic: { label: 'Romantic', telugu: 'ప్రేమ', how: 'lovingly', read: 'నువ్వు పక్కన ఉంటే, ప్రతి రోజూ పండగలా ఉంటుంది.', hint: 'Soft, warm and slow.' },
  crying: { label: 'Crying', telugu: 'ఏడుపు', how: 'while crying', read: 'అమ్మా... నన్ను వదిలి వెళ్ళకు, ప్లీజ్...', hint: 'Broken voice, sobbing pauses.' },
  laughing: { label: 'Laughing', telugu: 'నవ్వు', how: 'while laughing', read: 'హహహ! ఆగు ఆగు, నవ్వు ఆపుకోలేకపోతున్నా!', hint: 'Laugh through the words.' },
  shouting: { label: 'Shouting', telugu: 'అరుపు', how: 'shouting', read: 'ఒరేయ్! ఇటు రా! త్వరగా!', hint: 'Shout from a distance (not too close to the phone).' },
  serious: { label: 'Serious', telugu: 'గంభీరం', how: 'seriously', read: 'ఇది చాలా ముఖ్యమైన విషయం. జాగ్రత్తగా వినండి.', hint: 'Steady, deep and deliberate, like a news anchor.' },
  tired: { label: 'Tired', telugu: 'అలసట', how: 'tiredly', read: 'రోజంతా పని చేశా... ఇక ఓపిక లేదు.', hint: 'Low energy, slow, with sighs.' },
  nervous: { label: 'Nervous', telugu: 'కంగారు', how: 'nervously', read: 'అది... అంటే... నేను అనుకున్నది అది కాదు...', hint: 'Hesitant, quick, unsure.' },
  proud: { label: 'Proud', telugu: 'గర్వం', how: 'proudly', read: 'చూశారా? ఇది నా కష్టానికి ఫలితం.', hint: 'Chest out, confident and clear.' },
  sarcastic: { label: 'Sarcastic', telugu: 'వెటకారం', how: 'sarcastically', read: 'ఓహో, చాలా గొప్ప పని చేశావు, శభాష్.', hint: 'Drawn out, mocking tone.' },
  disgusted: { label: 'Disgusted', telugu: 'అసహ్యం', how: 'with disgust', read: 'ఛీ! ఇదేంటి, ఇంత దారుణంగా ఉంది.', hint: 'Nose wrinkled, pushing the words away.' },
};

const SYNONYMS: Record<string, Emotion> = {
  happy: 'happy', joy: 'happy', joyful: 'happy', cheerful: 'happy', smiling: 'happy', సంతోషం: 'happy', సంతోషంగా: 'happy', ఆనందం: 'happy', ఆనందంగా: 'happy',
  sad: 'sad', upset: 'sad', sorrow: 'sad', బాధ: 'sad', బాధగా: 'sad', దుఃఖం: 'sad', విచారం: 'sad',
  angry: 'angry', anger: 'angry', furious: 'angry', mad: 'angry', కోపం: 'angry', కోపంగా: 'angry',
  excited: 'excited', excitement: 'excited', energetic: 'excited', thrilled: 'excited', ఉత్సాహం: 'excited', ఉత్సాహంగా: 'excited',
  calm: 'calm', soft: 'calm', gentle: 'calm', neutral: 'calm', relaxed: 'calm', ప్రశాంతం: 'calm', ప్రశాంతంగా: 'calm', నెమ్మదిగా: 'calm',
  whisper: 'whisper', whispering: 'whisper', whispers: 'whisper', గుసగుస: 'whisper', గుసగుసగా: 'whisper',
  fearful: 'fearful', fear: 'fearful', scared: 'fearful', afraid: 'fearful', terrified: 'fearful', భయం: 'fearful', భయంగా: 'fearful',
  surprised: 'surprised', surprise: 'surprised', shocked: 'surprised', amazed: 'surprised', ఆశ్చర్యం: 'surprised', ఆశ్చర్యంగా: 'surprised',
  romantic: 'romantic', loving: 'romantic', love: 'romantic', tender: 'romantic', ప్రేమ: 'romantic', ప్రేమగా: 'romantic',
  crying: 'crying', cry: 'crying', cries: 'crying', sobbing: 'crying', tearful: 'crying', ఏడుపు: 'crying', ఏడుస్తూ: 'crying',
  laughing: 'laughing', laugh: 'laughing', laughs: 'laughing', giggling: 'laughing', నవ్వు: 'laughing', నవ్వుతూ: 'laughing',
  shouting: 'shouting', shout: 'shouting', shouts: 'shouting', yelling: 'shouting', screaming: 'shouting', loud: 'shouting', అరుపు: 'shouting', అరుస్తూ: 'shouting',
  serious: 'serious', stern: 'serious', formal: 'serious', news: 'serious', authoritative: 'serious', గంభీరం: 'serious', గంభీరంగా: 'serious',
  tired: 'tired', sleepy: 'tired', exhausted: 'tired', bored: 'tired', అలసట: 'tired', అలసటగా: 'tired',
  nervous: 'nervous', anxious: 'nervous', hesitant: 'nervous', worried: 'nervous', కంగారు: 'nervous', కంగారుగా: 'nervous', ఆందోళన: 'nervous',
  proud: 'proud', confident: 'proud', boastful: 'proud', గర్వం: 'proud', గర్వంగా: 'proud',
  sarcastic: 'sarcastic', sarcasm: 'sarcastic', mocking: 'sarcastic', వెటకారం: 'sarcastic', వెటకారంగా: 'sarcastic', వ్యంగ్యం: 'sarcastic',
  disgusted: 'disgusted', disgust: 'disgusted', grossed: 'disgusted', అసహ్యం: 'disgusted', అసహ్యంగా: 'disgusted',
};

/** "sad", "Sad", "బాధగా" -> 'sad'; unknown -> null. */
export function toEmotion(word: string | null | undefined): Emotion | null {
  if (!word) return null;
  return SYNONYMS[word.trim().toLowerCase()] ?? null;
}

/** Used when a voice has no recording for the emotion: speed, loudness and pause length. */
export const EMOTION_STYLE: Record<Emotion, { speed: number; gain: number; pause: number }> = {
  happy: { speed: 1.05, gain: 1.08, pause: 1 },
  sad: { speed: 0.88, gain: 0.82, pause: 1.4 },
  angry: { speed: 1.06, gain: 1.22, pause: 0.9 },
  excited: { speed: 1.12, gain: 1.15, pause: 0.8 },
  calm: { speed: 0.92, gain: 0.9, pause: 1.25 },
  whisper: { speed: 0.95, gain: 0.55, pause: 1.1 },
  fearful: { speed: 1.08, gain: 0.88, pause: 1.1 },
  surprised: { speed: 1.05, gain: 1.15, pause: 0.9 },
  romantic: { speed: 0.9, gain: 0.85, pause: 1.25 },
  crying: { speed: 0.85, gain: 0.8, pause: 1.5 },
  laughing: { speed: 1.08, gain: 1.1, pause: 0.9 },
  shouting: { speed: 1.02, gain: 1.35, pause: 0.9 },
  serious: { speed: 0.95, gain: 1, pause: 1.15 },
  tired: { speed: 0.85, gain: 0.8, pause: 1.4 },
  nervous: { speed: 1.1, gain: 0.9, pause: 0.8 },
  proud: { speed: 0.97, gain: 1.1, pause: 1.05 },
  sarcastic: { speed: 0.94, gain: 1, pause: 1.15 },
  disgusted: { speed: 0.95, gain: 1.05, pause: 1.1 },
};

/**
 * Token prepended to a fast voice's phonemes so it speaks in that emotion
 * (see personal-voice/dataset.py). Symbols Piper knows that Telugu phonemes
 * never use.
 */
export const EMOTION_TOKENS: Record<Emotion, string> = {
  happy: '1', sad: '2', angry: '3', excited: '4', calm: '5', whisper: '6', fearful: '7', surprised: '8', romantic: '9',
  crying: '0', laughing: 'q', shouting: 'x', serious: 'z', tired: 'f', nervous: 'w', proud: 'y', sarcastic: 'ç', disgusted: 'ð',
};
