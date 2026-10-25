/**
 * Multi-voice scripts, written like a play:
 *
 *   Amma: నాన్నా, భోజనం చేశావా?
 *   ME: ఇంకా లేదమ్మా.
 *   [pause 2s]
 *
 * A line "Name: text" is spoken by that speaker; lines without a name
 * continue with the previous speaker (or the default voice). A blank line
 * adds a short pause, "[pause 2s]" an exact one. Emotions: "Amma (sad): …"
 * or "[excited] …" (English or Telugu words), for that line. Other
 * [bracketed] stage directions are not read aloud.
 */

import { type Emotion, toEmotion } from './emotions';

export interface Segment {
  speaker: string | null;
  /** From "Name (sad):" or "[sad]"; null = the voice's normal tone. */
  emotion: Emotion | null;
  text: string;
  /** Silence after this segment, in seconds. */
  pauseAfter: number;
}

const SPEAKER = /^\s*([^\s:：(（][^:：(（\n]{0,23}?)\s*(?:[(（]\s*([^)）]{1,20})\s*[)）])?\s*[:：]\s*(.*)$/;
const PAUSE = /^\s*\[\s*(?:pause|విరామం)?\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\s*\]\s*$/i;
export const BLANK_LINE_PAUSE = 0.6;
export const SPEAKER_CHANGE_PAUSE = 0.3;

function looksLikeSpeaker(name: string): boolean {
  // Avoid treating "Note: …" style prose or times ("10:30") as speakers: short, no digits-only, few words.
  return !/^\d+$/.test(name) && name.split(/\s+/).length <= 3;
}

export function parseScript(script: string): Segment[] {
  const out: Segment[] = [];
  let speaker: string | null = null;
  const addPause = (sec: number) => {
    if (out.length) out[out.length - 1].pauseAfter = Math.max(out[out.length - 1].pauseAfter, sec);
  };
  for (const raw of script.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      addPause(BLANK_LINE_PAUSE);
      continue;
    }
    const p = PAUSE.exec(line);
    if (p) {
      addPause(Math.min(30, Number.parseFloat(p[1])));
      continue;
    }
    let text = line;
    let emotion: Emotion | null = null;
    const m = SPEAKER.exec(line);
    if (m && looksLikeSpeaker(m[1]) && !(/\d$/.test(m[1]) && /^\d/.test(m[3]))) {
      const next = m[1].trim();
      if (speaker !== null && next !== speaker) addPause(SPEAKER_CHANGE_PAUSE);
      speaker = next;
      emotion = toEmotion(m[2]);
      text = m[3].trim();
    }
    // Walk the line: [pause 1s] adds a pause, [excited] sets the emotion from there on,
    // other tags ([laughs]) are stage directions and are not read.
    let last = 0;
    const flush = (piece: string) => {
      const clean = piece.replace(/\s+/g, ' ').trim();
      if (clean) out.push({ speaker, emotion, text: clean, pauseAfter: 0 });
    };
    for (const tag of text.matchAll(/\[([^\]]{1,40})\]/g)) {
      flush(text.slice(last, tag.index));
      last = (tag.index ?? 0) + tag[0].length;
      const inner = tag[1];
      const p = /^\s*(?:pause|విరామం)?\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\s*$/i.exec(inner);
      if (p) {
        addPause(Math.min(30, Number.parseFloat(p[1])));
        continue;
      }
      const e = toEmotion(inner);
      if (e) emotion = e;
    }
    flush(text.slice(last));
  }
  return out;
}

/** Speakers in order of first appearance. */
export function speakersOf(segments: Segment[]): string[] {
  const seen: string[] = [];
  for (const s of segments) if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
  return seen;
}
