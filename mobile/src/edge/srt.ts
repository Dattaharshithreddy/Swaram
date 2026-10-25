/** Subtitle (.srt) parsing for dubbing. Pure module. */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

function seconds(t: string): number {
  const m = /(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/.exec(t.trim());
  if (!m) return Number.NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

export function parseSrt(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const [a, b] = lines[timeIdx].split('-->');
    const start = seconds(a);
    const end = seconds(b);
    const body = lines.slice(timeIdx + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}
