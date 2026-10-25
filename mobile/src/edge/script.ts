/**
 * Multi-voice scripts, written like a play:
 *
 *   Amma: నాన్నా, భోజనం చేశావా?
 *   ME: ఇంకా లేదమ్మా.
 *   [pause 2s]
 *
 * A line "Name: text" is spoken by that speaker; lines without a name
 * continue with the previous speaker (or the default voice). A blank line
 * adds a short pause, "[pause 2s]" an exact one.
 */

export interface Segment {
  speaker: string | null;
  text: string;
  /** Silence after this segment, in seconds. */
  pauseAfter: number;
}

const SPEAKER = /^\s*([^\s:：][^:：\n]{0,23}?)\s*[:：]\s*(.*)$/;
const PAUSE = /^\s*\[\s*(?:pause|విరామం)?\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\s*\]\s*$/i;
const INLINE_PAUSE = /\[\s*(?:pause|విరామం)?\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\s*\]/gi;
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
    const m = SPEAKER.exec(line);
    if (m && looksLikeSpeaker(m[1]) && !(/\d$/.test(m[1]) && /^\d/.test(m[2]))) {
      const next = m[1].trim();
      if (speaker !== null && next !== speaker) addPause(SPEAKER_CHANGE_PAUSE);
      speaker = next;
      text = m[2].trim();
    }
    // Inline [pause 1s] splits the line.
    const pieces = text.split(INLINE_PAUSE);
    for (let i = 0; i < pieces.length; i++) {
      if (i % 2 === 1) {
        addPause(Math.min(30, Number.parseFloat(pieces[i])));
        continue;
      }
      const piece = pieces[i].trim();
      if (piece) out.push({ speaker, text: piece, pauseAfter: 0 });
    }
  }
  return out;
}

/** Speakers in order of first appearance. */
export function speakersOf(segments: Segment[]): string[] {
  const seen: string[] = [];
  for (const s of segments) if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
  return seen;
}
