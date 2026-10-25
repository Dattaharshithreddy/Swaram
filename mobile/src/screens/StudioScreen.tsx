import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { usePlayer } from '../components/player';
import { Badge, Button, Card, CardTitle, Chip, Empty, Field, Header, Icon, IconButton, Label, Notice, ProgressBar, Screen, Segmented } from '../components/ui';
import { VoicePicker } from '../components/VoicePicker';
import { downloadAudio, downloadSubtitles, shareAudio } from '../download';
import { encodeWav } from '../edge/dsp';
import { readFloats } from '../edge/engine';
import {
  createScriptJob,
  deleteJob,
  isFinished,
  jobVoiceKeys,
  outputFile,
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
import { displayName, findVoice, keyOf, matchSpeaker, type VoiceRef } from '../edge/voices';
import { guidanceFor, QUALITY, SPEEDS, useApp } from '../state';
import { font, radius, space, speakerColors, useTheme } from '../theme';

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

function partWav(job: ScriptJob, i: number): Promise<string> {
  return readFloats(partFile(job, i)).then((x) => {
    const f = new File(Paths.cache, `swaram-line-${job.id}-${i}.wav`);
    if (f.exists) f.delete();
    f.writeSync(encodeWav(x));
    return f.uri;
  });
}

export function StudioScreen() {
  const t = useTheme();
  const app = useApp();
  const { voices, prefs, updatePrefs, running } = app;
  const [view, setView] = useState<'write' | 'lines'>('write');
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
  const speakers = useMemo(() => speakersOf(segments), [segments]);
  const hasUnlabelled = segments.some((s) => s.speaker === null);
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
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function make() {
    setError(null);
    try {
      if (usesBig && !app.installed) throw new Error('Download the offline model in Settings to use big-model voices.');
      const job = createScriptJob(script, {
        title,
        steps: prefs.steps,
        guidance: guidanceFor(prefs.steps),
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
      setError(e instanceof Error ? e.message : String(e));
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
          { key: 'lines', label: speakers.length ? `Lines & voices (${speakers.length})` : 'Lines & voices' },
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
                <Chip key={q.steps} label={q.label} selected={prefs.steps === q.steps} onPress={() => updatePrefs({ steps: q.steps })} />
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
          title={running ? 'Another script is being made…' : voiceCount > 1 ? `Make voice-over · ${voiceCount} voices` : 'Make voice-over'}
          icon="mic"
          onPress={make}
          disabled={!script.trim() || missing.length > 0 || running !== null}
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
        const out = outputFile(job);
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
            {openJob === job.id && <JobLines job={job} />}
          </View>
        );
      })}
    </View>
  );
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
      Alert.alert('Could not make the line again', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={{ gap: space.sm }}>
      <Notice text="Tap a line to hear it. Redo makes just that line again; the rest is kept." />
      {job.parts.map((p, i) => {
        const has = partFile(job, i).exists;
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
                    title="Play"
                    icon="play"
                    kind="secondary"
                    small
                    onPress={async () => {
                      const uri = await partWav(job, i);
                      await player.toggle(uri);
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
