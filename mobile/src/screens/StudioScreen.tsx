import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Modal, Pressable, Text, TextInput, View } from 'react-native';
import * as Sharing from 'expo-sharing';
import { SwaramEdge } from '../../modules/swaram-edge';
import { usePlayer } from '../components/player';
import { Badge, Button, Card, CardTitle, Chip, Empty, Field, Header, Icon, IconButton, Label, Notice, ProgressBar, Screen, Segmented } from '../components/ui';
import { VoicePicker } from '../components/VoicePicker';
import { downloadAudio, downloadSubtitles, shareAudio } from '../download';
import { encodeWav } from '../edge/dsp';
import { readFloats, writeFloats } from '../edge/engine';
import {
  createDubJob,
  createScriptJob,
  deleteJob,
  isFinished,
  jobVoiceKeys,
  addMusic,
  finalAudio,
  outputFile,
  removeMusic,
  setMusicVolume,
  partFile,
  partsDone,
  redoPart,
  type ScriptJob,
  setPartEmotion,
  setPartVoice,
  srtFile,
} from '../edge/jobs';
import { type Emotion, EMOTION_INFO, EMOTIONS } from '../edge/emotions';
import { duration } from '../edge/recent';
import { parseScript, speakersOf } from '../edge/script';
import { deleteSound, importSound, listSounds, type Sound } from '../edge/sounds';
import { parseSrt } from '../edge/srt';
import { displayName, findVoice, keyOf, matchSpeaker, type VoiceRef } from '../edge/voices';
import { studioInstalled } from '../edge/store';
import { effectiveSteps, guidanceFor, QUALITY, SPEEDS, useApp } from '../state';
import { font, radius, space, speakerColors, useTheme } from '../theme';
import { friendlyError } from '../errors';
import { cloudParts } from '../edge/kaggleRender';

const EXAMPLE = `Narrator (calm): అలా ఆ రోజు ఉదయం మొదలైంది.
Amma (sad): నాన్నా, భోజనం చేశావా? రాత్రంతా ఎక్కడ ఉన్నావు?
ME: [excited] అమ్మా! నాకు ఉద్యోగం వచ్చింది!
Amma (surprised): నిజంగానా? [happy] దేవుడా, ఎంత మంచి వార్త!
[pause 1s]
Narrator (serious): ఆ మాటతో కథ కొత్త మలుపు తిరిగింది.`;

/** True when the voice has a real recording (or learned token) for the emotion; else the style fallback is used. */
function emotionSupport(v: VoiceRef, e: Emotion): boolean {
  return v.kind === 'f5' ? !!v.voice.emotions?.[e] : (v.voice.emotions ?? []).includes(e);
}

/** A line as a WAV for the player, made natively (off the JS thread) and reused until the line changes. */
async function partWav(job: ScriptJob, i: number): Promise<string> {
  const src = partFile(job, i);
  const f = new File(Paths.cache, `swaram-line-${job.id}-${i}-${src.size}.wav`);
  if (f.exists) return f.uri;
  if (SwaramEdge) await SwaramEdge.joinWav([src.uri], f.uri, 0);
  else f.writeSync(encodeWav(await readFloats(src)));
  return f.uri;
}

/** The finished lines from the start (up to the first one not made yet), joined natively with their pauses. */
async function doneSoFarWav(job: ScriptJob): Promise<{ uri: string; lines: number } | null> {
  const files: string[] = [];
  let lines = 0;
  for (let i = 0; i < job.parts.length && partFile(job, i).exists; i++) {
    files.push(partFile(job, i).uri);
    const pause = job.parts[i].pauseAfter ?? 0;
    if (pause > 0) {
      const gap = new File(Paths.cache, `swaram-gap-${Math.round(pause * 10)}.f32`);
      if (!gap.exists) writeFloats(gap, new Float32Array(Math.round(pause * 24000)));
      files.push(gap.uri);
    }
    lines++;
  }
  if (!lines) return null;
  const f = new File(Paths.cache, `swaram-sofar-${job.id}-${lines}.wav`);
  if (!f.exists) {
    if (SwaramEdge) await SwaramEdge.joinWav(files, f.uri, 0);
    else return null;
  }
  return { uri: f.uri, lines };
}

/** Studio-quality render on Kaggle for a project: start it, show its progress. */
function CloudRender({ job, disabled }: { job: ScriptJob; disabled: boolean }) {
  const t = useTheme();
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const r = app.renders.find((x) => x.jobId === job.id && x.state !== 'done');
  if (!cloudParts(job).length) return null;

  async function start() {
    const c = app.creds;
    if (!c?.username || !c.token || !c.hfToken) {
      Alert.alert('Add your Kaggle keys first', 'Studio renders use your free Kaggle account. Add your Kaggle username, API token and Hugging Face token in Settings.', [
        { text: 'Later' },
        { text: 'Open Settings', onPress: () => app.setTab('settings') },
      ]);
      return;
    }
    setBusy(true);
    try {
      await app.startRender(job);
    } catch (e) {
      Alert.alert('Could not start the render', friendlyError(e, 'kaggle'));
    } finally {
      setBusy(false);
    }
  }

  if (r?.state === 'running') {
    return (
      <View style={{ gap: 6 }}>
        <Notice text={`${r.detail ?? 'Rendering on Kaggle…'} The lines drop into this project by themselves; keep the app open now and then so it can check.`} />
        <View style={{ flexDirection: 'row', gap: space.lg }}>
          <Text style={{ color: t.accent, fontFamily: font.bold, fontSize: 13 }} onPress={() => void app.checkTrainings()}>
            {app.checkingTrainings ? 'Checking…' : 'Check now'}
          </Text>
          {r.url && (
            <Text style={{ color: t.soft, fontFamily: font.bold, fontSize: 13 }} onPress={() => void Linking.openURL(r.url as string)}>
              Open on Kaggle
            </Text>
          )}
        </View>
      </View>
    );
  }
  return (
    <View style={{ gap: 6 }}>
      {r?.state === 'failed' && (
        <>
          <Notice text={r.detail ?? 'The studio render failed.'} kind="error" />
          <Text style={{ color: t.soft, fontFamily: font.bold, fontSize: 13 }} onPress={() => app.dismissRender(r)}>
            Dismiss
          </Text>
        </>
      )}
      <Button
        title="Studio render on Kaggle (best quality)"
        icon="cloud"
        kind="gold"
        small
        busy={busy}
        disabled={disabled || app.running !== null}
        onPress={() =>
          Alert.alert(
            'Studio render',
            'Makes every big-model line again with the full model at maximum quality on your free Kaggle GPU. Usually 10-20 minutes and needs internet. The project updates by itself when it is done.',
            [{ text: 'Cancel', style: 'cancel' }, { text: 'Start', onPress: () => void start() }],
          )
        }
      />
    </View>
  );
}

export function StudioScreen() {
  const t = useTheme();
  const app = useApp();
  const { voices, prefs, updatePrefs, running } = app;
  const [view, setView] = useState<'write' | 'lines' | 'dub'>('write');
  const [srt, setSrt] = useState<{ name: string; text: string } | null>(null);
  const [sounds, setSounds] = useState<Sound[]>(() => listSounds());
  const [soundName, setSoundName] = useState('');
  const [script, setScript] = useState(prefs.draft);
  const [title, setTitle] = useState(prefs.draftTitle);
  const [picker, setPicker] = useState<{ speaker: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Autosave the draft.
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => updatePrefs({ draft: script, draftTitle: title }), 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [script, title, updatePrefs]);

  const segments = useMemo(() => parseScript(script), [script]);
  const cues = useMemo(() => (srt ? parseSrt(srt.text) : []), [srt]);
  const dubSegments = useMemo(() => cues.flatMap((c) => parseScript(c.text).slice(0, 1)), [cues]);
  const active = view === 'dub' ? dubSegments : segments;
  const speakers = useMemo(() => speakersOf(active), [active]);
  const hasUnlabelled = active.some((s) => s.speaker === null && !s.sound);
  const defaultVoice = findVoice(prefs.defaultVoice, voices) ?? voices[0];

  const voiceForSpeaker = (sp: string | null): VoiceRef | undefined => {
    if (sp === null) return defaultVoice;
    return findVoice(prefs.speakerVoices[sp], voices) ?? matchSpeaker(sp, voices);
  };
  const colorOf = (sp: string | null) => (sp === null ? t.soft : speakerColors[speakers.indexOf(sp) % speakerColors.length]);
  const missing = speakers.filter((sp) => !voiceForSpeaker(sp));
  const usedRefs = [...new Map([...(hasUnlabelled ? [null] : []), ...speakers].map((sp) => [sp, voiceForSpeaker(sp)])).values()].filter(Boolean) as VoiceRef[];
  const usesBig = usedRefs.some((r) => r.kind === 'f5');
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;
  const voiceCount = new Set(usedRefs.map(keyOf)).size;

  async function loadFile() {
    const res = await DocumentPicker.getDocumentAsync({ type: ['text/plain', 'text/*'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    try {
      setScript(await new File(res.assets[0].uri).text());
      if (!title) setTitle(res.assets[0].name.replace(/\.[^.]+$/, ''));
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  async function loadSrt() {
    const res = await DocumentPicker.getDocumentAsync({ type: ['application/x-subrip', 'text/*', '*/*'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    try {
      const text = await new File(res.assets[0].uri).text();
      if (!parseSrt(text).length) throw new Error('No subtitles found in this file. Use a .srt file.');
      setSrt({ name: res.assets[0].name, text });
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  async function addSound() {
    const res = await DocumentPicker.getDocumentAsync({ type: ['audio/*', 'video/*'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    try {
      const name = soundName.trim() || res.assets[0].name.replace(/\.[^.]+$/, '');
      await importSound(res.assets[0].uri, name);
      setSounds(listSounds());
      setSoundName('');
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  async function make() {
    setError(null);
    try {
      if (usesBig && !app.installed) throw new Error('Download the offline model in Settings to use big-model voices.');
      const build = view === 'dub' ? (o: Parameters<typeof createScriptJob>[1]) => createDubJob(srt?.text ?? '', { ...o, title: title || srt?.name.replace(/\.[^.]+$/, '') }) : (o: Parameters<typeof createScriptJob>[1]) => createScriptJob(script, o);
      const job = build({
        title,
        steps: effectiveSteps(prefs),
        guidance: guidanceFor(effectiveSteps(prefs)),
        speed: prefs.speed,
        voiceFor: (sp) => {
          const r = voiceForSpeaker(sp);
          return r ? keyOf(r) : undefined;
        },
        prepare: app.prepare,
      });
      app.refreshJobs();
      setOpenJob(job.id);
      void app.startJob(job);
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  if (voices.length === 0) {
    return (
      <Screen>
        <Header title="Studio" subtitle="Scripts and voice-overs, one voice or many" />
        <Card>
          <Empty
            icon="file-text"
            title="Add a voice first"
            text="Studio turns scripts into voice-overs. Make a voice, then come back here."
            action={<Button title="New voice" icon="plus" onPress={() => app.setPage({ name: 'newVoice' })} style={{ marginTop: space.sm }} />}
          />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header
        title="Studio"
        subtitle={words ? `${speakers.length > 1 ? `${speakers.length} speakers · ` : ''}${words} words · about ${Math.max(1, Math.round(words / 130))} min` : 'Scripts and voice-overs, one voice or many'}
        right={<Button title="Load .txt" icon="upload" kind="secondary" small onPress={loadFile} />}
      />
      <Segmented
        options={[
          { key: 'write', label: 'Write' },
          { key: 'lines', label: view !== 'dub' && speakers.length ? `Voices (${speakers.length})` : 'Voices' },
          { key: 'dub', label: 'Dub' },
        ]}
        value={view}
        onChange={setView}
      />

      {view === 'write' ? (
        <Card>
          <Field label="Title (optional)" value={title} onChangeText={setTitle} placeholder="Episode 5" />
          <View style={{ gap: 6 }}>
            <Label>Script</Label>
            <TextInput
              value={script}
              onChangeText={setScript}
              multiline
              accessibilityLabel="Script"
              placeholder={'Write or paste your script.\n\nFor several voices, start lines with a name:\nAmma: …\nME: …'}
              placeholderTextColor={t.faint}
              style={{ minHeight: 220, maxHeight: 420, textAlignVertical: 'top', borderRadius: radius.md, borderWidth: 1, borderColor: t.lineStrong, backgroundColor: t.field, color: t.ink, padding: 12, fontSize: 15, lineHeight: 25 }}
            />
          </View>
          <View style={{ flexDirection: 'row', gap: space.md, flexWrap: 'wrap' }}>
            <Pressable accessibilityRole="button" onPress={() => setScript(EXAMPLE)}>
              <Text style={{ color: t.accent, fontFamily: font.bold, fontSize: 13 }}>Use a 3-voice example with emotions</Text>
            </Pressable>
            {script ? (
              <Pressable accessibilityRole="button" onPress={() => Alert.alert('Clear the script?', '', [{ text: 'Keep' }, { text: 'Clear', style: 'destructive', onPress: () => setScript('') }])}>
                <Text style={{ color: t.soft, fontFamily: font.bold, fontSize: 13 }}>Clear</Text>
              </Pressable>
            ) : null}
          </View>
          <Notice text="Tips: “Name: text” picks the speaker · “Name (sad): text” or [excited] sets the emotion · a blank line adds a short pause · [pause 2s] an exact one · English letters are read as Telugu." />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {EMOTIONS.map((e) => (
              <Pressable key={e} accessibilityRole="button" accessibilityLabel={`Insert ${e} tag`} onPress={() => setScript((cur) => `${cur}${cur && !cur.endsWith('\n') && !cur.endsWith(' ') ? ' ' : ''}[${e}] `)}>
                <Badge text={EMOTION_INFO[e].label} />
              </Pressable>
            ))}
          </View>
          <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: t.surface2, paddingTop: space.md }}>
            <Label>Sound clips</Label>
            <Notice text="Your own sounds (door, bell, applause…). Tap one to put it in the script as [sound: name]." />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {sounds.map((snd) => (
                <Pressable
                  key={snd.name}
                  accessibilityRole="button"
                  accessibilityLabel={`Insert sound ${snd.name}`}
                  onPress={() => setScript((cur) => `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}[sound: ${snd.name}]\n`)}
                  onLongPress={() =>
                    Alert.alert(`Delete the sound "${snd.name}"?`, '', [
                      { text: 'Keep' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () => {
                          deleteSound(snd.name);
                          setSounds(listSounds());
                        },
                      },
                    ])
                  }
                >
                  <Badge text={`${snd.name} · ${snd.seconds.toFixed(1)}s`} icon="music" />
                </Pressable>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-end' }}>
              <View style={{ flex: 1 }}>
                <Field value={soundName} onChangeText={setSoundName} placeholder="Name, e.g. door" autoCapitalize="none" />
              </View>
              <Button title="Add sound" icon="plus" kind="secondary" small onPress={addSound} style={{ minHeight: 48 }} />
            </View>
          </View>
        </Card>
      ) : view === 'dub' ? (
        <Card>
          <Label>Dub from subtitles</Label>
          <Notice text="Load a Telugu .srt file: every subtitle is spoken in your voice at its time, sped up a little if it's too long. Subtitles can start with a name (Amma: …) and use emotion tags. Afterwards you can put the new voice onto your video." />
          <Button title={srt ? `Change file · ${srt.name}` : 'Load .srt file'} icon="upload" kind={srt ? 'secondary' : 'primary'} onPress={loadSrt} />
          {srt && cues.length > 0 && (
            <Notice text={`${cues.length} subtitles · ${Math.floor(cues[cues.length - 1].end / 60)}:${String(Math.round(cues[cues.length - 1].end % 60)).padStart(2, '0')} long${speakers.length ? ` · speakers: ${speakers.join(', ')}` : ''}`} kind="ok" />
          )}
          {[...(hasUnlabelled ? [null] : []), ...speakers].map((sp) => {
            const v = voiceForSpeaker(sp);
            return (
              <View key={sp ?? '__default'} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
                <Text numberOfLines={1} style={{ color: t.ink, fontFamily: font.semibold, fontSize: 14, flex: 1 }}>{sp ?? 'Subtitles without a name'}</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setPicker({ speaker: sp })}
                  style={{ minHeight: 40, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: v ? t.lineStrong : t.accent, backgroundColor: t.field, flexDirection: 'row', alignItems: 'center', gap: 6 }}
                >
                  <Text style={{ color: v ? (v.kind === 'fast' ? t.goldText : t.ink) : t.accent, fontFamily: font.semibold, fontSize: 13 }}>{v ? displayName(v) : 'Choose voice'}</Text>
                  <Icon name="chevron-down" size={14} color={t.soft} />
                </Pressable>
              </View>
            );
          })}
        </Card>
      ) : (
        <>
          <Card>
            <Label>Speakers in this script</Label>
            {speakers.length === 0 && !hasUnlabelled && <Notice text="Write a script first." />}
            {[...(hasUnlabelled ? [null] : []), ...speakers].map((sp) => {
              const v = voiceForSpeaker(sp);
              return (
                <View key={sp ?? '__default'} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colorOf(sp) }} />
                    <Text numberOfLines={1} style={{ color: t.ink, fontFamily: font.semibold, fontSize: 14, flexShrink: 1 }}>
                      {sp ?? 'Lines without a name'}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Voice for ${sp ?? 'lines without a name'}`}
                    onPress={() => setPicker({ speaker: sp })}
                    style={{ minHeight: 40, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: v ? t.lineStrong : t.accent, backgroundColor: t.field, flexDirection: 'row', alignItems: 'center', gap: 6 }}
                  >
                    <Text style={{ color: v ? (v.kind === 'fast' ? t.goldText : t.ink) : t.accent, fontFamily: font.semibold, fontSize: 13 }}>{v ? displayName(v) : 'Choose voice'}</Text>
                    <Icon name="chevron-down" size={14} color={t.soft} />
                  </Pressable>
                </View>
              );
            })}
          </Card>
          <View style={{ gap: space.sm }}>
            {segments.slice(0, 60).map((s, i) => {
              const v = voiceForSpeaker(s.speaker);
              return (
                <View key={`${i}-${s.text.slice(0, 8)}`} style={{ flexDirection: 'row', gap: 10, backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 14, padding: 12 }}>
                  <View style={{ width: 4, borderRadius: 2, backgroundColor: colorOf(s.speaker) }} />
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={{ color: colorOf(s.speaker), fontFamily: font.bold, fontSize: 11 }}>
                      {(s.speaker ?? 'Default').toUpperCase()} · {v ? displayName(v) : 'no voice'}
                      {s.emotion ? `  ·  ${EMOTION_INFO[s.emotion].label}${v && emotionSupport(v, s.emotion) ? '' : ' (style)'}` : ''}
                      {s.pauseAfter ? `  ·  then ${s.pauseAfter}s pause` : ''}
                    </Text>
                    <Text style={{ color: t.ink, fontSize: 14, lineHeight: 23 }}>{s.text}</Text>
                  </View>
                </View>
              );
            })}
            {segments.length > 60 && <Notice text={`…and ${segments.length - 60} more lines.`} />}
          </View>
        </>
      )}

      <Card>
        {usesBig && (
          <View style={{ gap: space.sm }}>
            <Label>Big-model quality</Label>
            <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
              {QUALITY.map((q) => (
                <Chip
                  key={q.steps}
                  label={q.label}
                  selected={prefs.steps === q.steps}
                  onPress={async () => {
                    updatePrefs({ steps: q.steps, studio: false });
                    if (prefs.studio) await app.releaseEngine();
                  }}
                />
              ))}
            </View>
          </View>
        )}
        <View style={{ gap: space.sm }}>
          <Label>Speed</Label>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            {SPEEDS.map((s) => (
              <Chip key={s} label={s === 1 ? 'Normal' : s < 1 ? 'Slower' : 'Faster'} selected={prefs.speed === s} onPress={() => updatePrefs({ speed: s })} />
            ))}
          </View>
        </View>
        {missing.length > 0 && <Notice text={`Choose a voice for: ${missing.join(', ')} (Lines & voices tab).`} kind="error" />}
        <Button
          title={running ? 'Another script is being made…' : view === 'dub' ? 'Make dub' : voiceCount > 1 ? `Make voice-over · ${voiceCount} voices` : 'Make voice-over'}
          icon="mic"
          onPress={make}
          disabled={(view === 'dub' ? !cues.length : !script.trim()) || missing.length > 0 || running !== null}
        />
        {error && <Notice text={error} kind="error" />}
      </Card>

      <Projects openJob={openJob} setOpenJob={setOpenJob} />

      <VoicePicker
        visible={picker !== null}
        title={picker?.speaker ? `Voice for ${picker.speaker}` : 'Voice for lines without a name'}
        voices={voices}
        selectedKey={picker ? (() => {
          const v = voiceForSpeaker(picker.speaker);
          return v ? keyOf(v) : undefined;
        })() : undefined}
        onPick={(v) => {
          if (!picker) return;
          if (picker.speaker === null) updatePrefs({ defaultVoice: keyOf(v) });
          else updatePrefs({ speakerVoices: { ...prefs.speakerVoices, [picker.speaker]: keyOf(v) } });
        }}
        onClose={() => setPicker(null)}
      />
    </Screen>
  );
}

function Projects({ openJob, setOpenJob }: { openJob: string | null; setOpenJob: (id: string | null) => void }) {
  const t = useTheme();
  const app = useApp();
  const { jobs, running } = app;
  const player = usePlayer();
  const [musicFor, setMusicFor] = useState<string | null>(null);
  const [videoBusy, setVideoBusy] = useState<string | null>(null);

  async function makeVideo(job: ScriptJob) {
    const res = await DocumentPicker.getDocumentAsync({ type: ['video/*'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0] || !SwaramEdge) return;
    setVideoBusy(job.id);
    try {
      const audio = new File(Paths.cache, `swaram-video-audio-${job.id}.m4a`);
      const out = new File(Paths.cache, `swaram-video-${job.id}.mp4`);
      for (const f of [audio, out]) if (f.exists) f.delete();
      await SwaramEdge.encodeM4a(finalAudio(job).uri, audio.uri, 128000);
      await SwaramEdge.muxVideo(res.assets[0].uri, audio.uri, out.uri);
      const safe = job.title.replace(/[^A-Za-z0-9\u0C00-\u0C7F]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'swaram';
      const where = await SwaramEdge.saveToDownloads(out.uri, `${safe}-dubbed.mp4`, 'video/mp4');
      Alert.alert('Video ready', `Saved to ${where}.`, [
        { text: 'OK' },
        { text: 'Share', onPress: () => void Sharing.shareAsync(out.uri, { mimeType: 'video/mp4' }) },
      ]);
    } catch (e) {
      Alert.alert('Could not make the video', friendlyError(e));
    } finally {
      setVideoBusy(null);
    }
  }

  if (jobs.length === 0) return null;
  return (
    <View style={{ gap: space.sm }}>
      <CardTitle>Projects</CardTitle>
      {app.jobError && <Notice text={app.jobError} kind="error" />}
      {jobs.map((job) => {
        const isRunning = running?.job.id === job.id;
        const done = isRunning && running?.progress ? running.progress.partsDone : partsDone(job);
        const finished = isFinished(job);
        const frac = isRunning && running?.progress ? running.progress.stepsDone / Math.max(1, running.progress.stepsTotal) : done / job.parts.length;
        const perPart = done > 0 ? job.computeSeconds / Math.max(1, partsDone(job)) : 0;
        const left = perPart * (job.parts.length - done);
        const voicesLabel = jobVoiceKeys(job).map((k) => job.voiceNames[k] ?? 'voice').join(', ');
        const out = finalAudio(job);
        return (
          <View key={job.id} style={{ backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: 16, padding: 14, gap: 10 }}>
            <Pressable accessibilityRole="button" onPress={() => setOpenJob(openJob === job.id ? null : job.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              {finished && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={player.isPlaying(out.uri) ? 'Pause' : 'Play'}
                  onPress={() => void player.toggle(out.uri)}
                  style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: player.isPlaying(out.uri) ? t.accent : t.surface2, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name={player.isPlaying(out.uri) ? 'pause' : 'play'} size={16} color={player.isPlaying(out.uri) ? t.onAccent : t.ink} />
                </Pressable>
              )}
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={{ color: t.ink, fontFamily: font.bold, fontSize: 14 }}>{job.title}</Text>
                <Text numberOfLines={2} style={{ color: t.soft, fontFamily: font.regular, fontSize: 12 }}>
                  {voicesLabel} · {finished ? `${duration(job.audioSeconds)} · made in ${Math.max(1, Math.round(job.computeSeconds / 60))} min` : `part ${Math.min(done + 1, job.parts.length)} of ${job.parts.length}${left ? ` · about ${left < 90 ? `${Math.round(left)} s` : `${Math.round(left / 60)} min`} left` : ''}`}
                </Text>
              </View>
              <Icon name={openJob === job.id ? 'chevron-up' : 'chevron-down'} color={t.faint} />
            </Pressable>
            {!finished && <ProgressBar value={frac} />}
            <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
              {finished ? (
                <>
                  <Button title="Download" icon="download" kind="secondary" small onPress={() => void downloadAudio(out.uri, job.title)} />
                  <Button title="Share" icon="share-2" kind="secondary" small onPress={() => void shareAudio(out.uri)} />
                  {srtFile(job).exists && <Button title="Subtitles" icon="type" kind="secondary" small onPress={() => void downloadSubtitles(srtFile(job).uri, job.title)} />}
                  <Button title={job.music ? 'Music ✓' : 'Add music'} icon="music" kind="secondary" small onPress={() => setMusicFor(musicFor === job.id ? null : job.id)} />
                  <Button title="Put on a video" icon="film" kind="secondary" small busy={videoBusy === job.id} onPress={() => void makeVideo(job)} />
                </>
              ) : isRunning ? (
                <Button title={running?.stop ? 'Stopping after this part…' : 'Stop'} icon="square" kind="secondary" small onPress={app.stopJob} />
              ) : (
                <Button title="Resume" icon="play" small onPress={() => void app.startJob(job)} disabled={running !== null} />
              )}
              {!isRunning && (
                <Button
                  title="Delete"
                  icon="trash-2"
                  kind="danger"
                  small
                  onPress={() =>
                    Alert.alert('Delete this project?', 'Its audio and subtitles are removed from the phone.', [
                      { text: 'Keep' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () => {
                          deleteJob(job);
                          app.refreshJobs();
                        },
                      },
                    ])
                  }
                />
              )}
            </View>
            <CloudRender job={job} disabled={isRunning} />
            {musicFor === job.id && finished && <MusicPanel job={job} onChanged={app.refreshJobs} />}
            {openJob === job.id && <JobLines job={job} />}
          </View>
        );
      })}
    </View>
  );
}

/** Background music under a finished project: pick a file, set the volume, remove. */
function MusicPanel({ job, onChanged }: { job: ScriptJob; onChanged: () => void }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const levels = [
    { gain: 0.12, label: 'Soft' },
    { gain: 0.22, label: 'Medium' },
    { gain: 0.38, label: 'Loud' },
  ];

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: space.sm, backgroundColor: t.bg, borderRadius: 12, padding: 12 }}>
      <Label>Background music</Label>
      <Notice text="Any song or music file. It loops under the voice, dips while someone speaks, and fades in and out. Use music you have the rights to." />
      {job.music ? (
        <>
          <Text style={{ color: t.ink, fontFamily: font.semibold, fontSize: 13 }}>♪ {job.music.name}</Text>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            {levels.map((l) => (
              <Chip key={l.label} label={l.label} selected={Math.abs((job.music?.gain ?? 0) - l.gain) < 0.01} onPress={() => void run(() => setMusicVolume(job, l.gain))} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button title="Change music" icon="refresh-cw" kind="secondary" small busy={busy} onPress={() => void pick()} />
            <Button
              title="Remove music"
              icon="x"
              kind="danger"
              small
              onPress={() => {
                removeMusic(job);
                onChanged();
              }}
            />
          </View>
        </>
      ) : (
        <Button title="Choose music file" icon="music" small busy={busy} onPress={() => void pick()} />
      )}
      {error && <Notice text={error} kind="error" />}
    </View>
  );

  async function pick() {
    const res = await DocumentPicker.getDocumentAsync({ type: ['audio/*'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    await run(() => addMusic(job, a.uri, a.name.replace(/\.[^.]+$/, ''), job.music?.gain ?? 0.22));
  }
}

/** Every part of a project: play it, change its voice or words, make it again. */
function JobLines({ job }: { job: ScriptJob }) {
  const t = useTheme();
  const app = useApp();
  const player = usePlayer();
  const [busy, setBusy] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ i: number; text: string } | null>(null);
  const [picker, setPicker] = useState<number | null>(null);
  const [emoPicker, setEmoPicker] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const isRunning = app.running?.job.id === job.id;
  const [soFarUri, setSoFarUri] = useState<string | null>(null);
  const [loadingLine, setLoadingLine] = useState<number | null>(null);
  const [lineUri, setLineUri] = useState<Record<number, string>>({});
  const soFarPlaying = soFarUri ? player.isPlaying(soFarUri) : false;
  const firstMissing = job.parts.findIndex((_, i) => !partFile(job, i).exists);
  const speakers = [...new Set(job.parts.map((p) => p.speaker).filter(Boolean))] as string[];

  async function redo(i: number, text?: string) {
    setBusy(i);
    try {
      await redoPart(job, i, app.makerFor({ steps: job.steps, guidance: job.guidance, speed: job.speed }), text);
      setEditing(null);
      app.refreshJobs();
      setTick((n) => n + 1);
      const uri = await partWav(job, i);
      await player.toggle(uri);
    } catch (e) {
      Alert.alert('Could not make the line again', friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={{ gap: space.sm }}>
      <Notice text={isRunning ? 'You can play lines as soon as they finish; no need to wait for all of them.' : 'Tap Play to hear a line. Redo makes just that line again; the rest is kept.'} />
      {isRunning && partFile(job, 0).exists && (
        <Button
          title={soFarPlaying ? 'Pause' : 'Play everything finished so far'}
          icon={soFarPlaying ? 'pause' : 'play'}
          kind="secondary"
          onPress={async () => {
            if (soFarPlaying && soFarUri) {
              await player.toggle(soFarUri);
              return;
            }
            const r = await doneSoFarWav(job);
            if (r) {
              setSoFarUri(r.uri);
              await player.toggle(r.uri);
            }
          }}
        />
      )}
      {job.parts.map((p, i) => {
        const has = partFile(job, i).exists;
        const making = isRunning && !has && i === firstMissing;
        const color = p.speaker ? speakerColors[speakers.indexOf(p.speaker) % speakerColors.length] : t.soft;
        return (
          <View key={i} style={{ flexDirection: 'row', gap: 10, backgroundColor: t.bg, borderRadius: 12, padding: 10 }}>
            <View style={{ width: 4, borderRadius: 2, backgroundColor: color }} />
            <View style={{ flex: 1, gap: 6 }}>
              <Pressable accessibilityRole="button" onPress={() => setPicker(i)} disabled={isRunning}>
                <Text style={{ color, fontFamily: font.bold, fontSize: 11 }}>
                  {(p.speaker ?? 'Line').toUpperCase()} · {job.voiceNames[p.voice] ?? 'voice'} ▾
                </Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Change emotion" onPress={() => setEmoPicker(i)} disabled={isRunning} style={{ alignSelf: 'flex-start' }}>
                <Badge text={p.emotion ? EMOTION_INFO[p.emotion].label : 'Normal tone'} kind={p.emotion ? 'gold' : 'plain'} icon="smile" />
              </Pressable>
              {isRunning && (
                <Badge text={has ? 'Ready' : making ? 'Making now…' : 'Waiting'} kind={has ? 'ok' : making ? 'gold' : 'plain'} icon={has ? 'check' : making ? 'loader' : 'clock'} />
              )}
              {editing?.i === i ? (
                <TextInput
                  value={editing.text}
                  onChangeText={(text) => setEditing({ i, text })}
                  multiline
                  autoFocus
                  accessibilityLabel="Line text"
                  style={{ color: t.ink, fontSize: 14, lineHeight: 23, borderWidth: 1, borderColor: t.lineStrong, borderRadius: 10, padding: 8, backgroundColor: t.field }}
                />
              ) : (
                <Text style={{ color: has ? t.ink : t.soft, fontSize: 14, lineHeight: 23 }}>{p.text}</Text>
              )}
              <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
                {has && !editing && (
                  <Button
                    title={lineUri[i] && player.isPlaying(lineUri[i]) ? 'Pause' : 'Play'}
                    icon={lineUri[i] && player.isPlaying(lineUri[i]) ? 'pause' : 'play'}
                    kind="secondary"
                    small
                    busy={loadingLine === i}
                    onPress={async () => {
                      setLoadingLine(i);
                      try {
                        const uri = await partWav(job, i);
                        setLineUri((m) => ({ ...m, [i]: uri }));
                        await player.toggle(uri);
                      } finally {
                        setLoadingLine(null);
                      }
                    }}
                  />
                )}
                {editing?.i === i ? (
                  <>
                    <Button title="Make again" icon="refresh-cw" small busy={busy === i} onPress={() => void redo(i, editing.text)} />
                    <Button title="Cancel" kind="secondary" small onPress={() => setEditing(null)} />
                  </>
                ) : (
                  <>
                    <Button title="Redo" icon="refresh-cw" kind="secondary" small busy={busy === i} disabled={isRunning || busy !== null} onPress={() => void redo(i)} />
                    <IconButton icon="edit-2" label="Edit words" onPress={() => setEditing({ i, text: p.text })} />
                  </>
                )}
                {p.pauseAfter > 0 && <Badge text={`${p.pauseAfter}s pause`} />}
              </View>
            </View>
          </View>
        );
      })}
      <Modal visible={emoPicker !== null} transparent animationType="slide" onRequestClose={() => setEmoPicker(null)}>
        <Pressable accessibilityLabel="Close" onPress={() => setEmoPicker(null)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }} />
        <View style={{ backgroundColor: t.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: space.lg, gap: space.md }}>
          <Text style={{ color: t.ink, fontFamily: font.bold, fontSize: 17 }}>Emotion for this line</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {[null, ...EMOTIONS].map((e) => (
              <Chip
                key={e ?? 'normal'}
                label={e ? EMOTION_INFO[e].label : 'Normal'}
                selected={emoPicker !== null && (job.parts[emoPicker].emotion ?? null) === e}
                onPress={() => {
                  if (emoPicker === null) return;
                  const i = emoPicker;
                  setEmoPicker(null);
                  setPartEmotion(job, i, e);
                  app.refreshJobs();
                  void redo(i);
                }}
              />
            ))}
          </View>
          <Notice text="Voices with a recording in that emotion sound most convincing (Voices → Add emotions)." />
        </View>
      </Modal>
      <VoicePicker
        visible={picker !== null}
        title="Voice for this line"
        voices={app.voices}
        selectedKey={picker !== null ? job.parts[picker].voice : undefined}
        onPick={(v) => {
          if (picker === null) return;
          setPartVoice(job, picker, v);
          app.refreshJobs();
          void redo(picker);
        }}
        onClose={() => setPicker(null)}
      />
    </View>
  );
}
