import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, type CloneEngine, type DesignPreview, type ServerConfig } from '../api';
import { Body, Button, Card, Chip, Field, Label, Notice, Title } from '../components/ui';
import { friendlyError } from '../errors';
import { cloneEnginesFor, engineFor, LANGUAGES, type LanguageCode, languageByCode } from '../languages';
import { radius, space, useTheme } from '../theme';

/** Speaker names Indic Parler-TTS was trained with; naming one gives a steadier voice. */
const SPEAKERS: Partial<Record<LanguageCode, string[]>> = {
  as: ['Amit', 'Sita'],
  bn: ['Arjun', 'Aditi'],
  en: ['Thoma', 'Mary'],
  gu: ['Yash', 'Neha'],
  hi: ['Rohit', 'Divya'],
  kn: ['Suresh', 'Anu'],
  ml: ['Anjali', 'Harish'],
  mr: ['Sanjay', 'Sunita'],
  or: ['Manas', 'Debjani'],
  pa: ['Divjot', 'Gurpreet'],
  ta: ['Jaya', 'Kavitha'],
  te: ['Prakash', 'Lalitha'],
};

/** Tap-to-add phrases, grouped so only one per group is used. */
const TRAITS: { group: string; options: string[] }[] = [
  { group: 'Voice', options: ['a woman', 'a man'] },
  { group: 'Pitch', options: ['low-pitched', 'moderate pitch', 'high-pitched'] },
  { group: 'Pace', options: ['slow and calm', 'moderate pace', 'fast and lively'] },
  { group: 'Style', options: ['warm and gentle', 'confident and crisp', 'cheerful and animated', 'serious news-reader'] },
];

const MAX_PREVIEWS = 3;

export function DesignVoiceScreen({
  config,
  onDone,
  onCancel,
}: {
  config: ServerConfig;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [name, setName] = useState('');
  const [language, setLanguage] = useState<LanguageCode>('te');
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [traits, setTraits] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState('');
  const [previews, setPreviews] = useState<DesignPreview[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [engine, setEngine] = useState<string>(engineFor('te'));
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const lang = languageByCode(language);

  const description = [
    speaker ? `${speaker} speaks` : 'The speaker is',
    Object.values(traits).join(', ') || 'a natural, clear voice',
  ].join(' ') + (extra.trim() ? `. ${extra.trim()}` : '') + '. Very clear, close-up recording with no background noise.';

  function changeLanguage(code: LanguageCode) {
    setLanguage(code);
    setSpeaker(null);
    setEngine(engineFor(code));
    setPreviews([]);
    setChosen(null);
  }

  function toggleTrait(group: string, option: string) {
    setTraits((prev) => {
      const next = { ...prev };
      if (next[group] === option) delete next[group];
      else next[group] = option;
      return next;
    });
  }

  async function play(p: DesignPreview) {
    if (playing === p.preview_id && status.playing) {
      player.pause();
      return;
    }
    await setAudioModeAsync({ playsInSilentMode: true });
    if (playing !== p.preview_id) {
      player.replace({ uri: p.uri });
      setPlaying(p.preview_id);
    } else if (status.duration > 0 && status.currentTime >= status.duration - 0.05) {
      void player.seekTo(0);
    }
    player.play();
  }

  async function preview() {
    setBusy('preview');
    setError(null);
    try {
      const p = await api.previewDesign(config, {
        description,
        language,
        seed: Math.floor(Math.random() * 100000),
      });
      setPreviews((prev) => [p, ...prev].slice(0, MAX_PREVIEWS));
      setChosen(p.preview_id);
      void play(p);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    const p = previews.find((x) => x.preview_id === chosen);
    if (!p) return;
    setBusy('save');
    setError(null);
    try {
      await api.saveDesign(config, {
        name: name.trim(),
        description: p.description,
        language,
        previewId: p.preview_id,
        engine: engine as CloneEngine,
        text: p.text,
      });
      onDone();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title>Describe a voice</Title>
        <Button title="Cancel" kind="secondary" onPress={onCancel} />
      </View>
      <Body muted>No recording needed. Describe the voice, listen to a few takes, keep the one you like.</Body>

      <Card>
        <Field label="Voice name" value={name} onChangeText={setName} placeholder="e.g. Ammamma" maxLength={100} />
        <Label>Language</Label>
        <View style={styles.wrap}>
          {LANGUAGES.map((l) => (
            <Chip
              key={l.code}
              label={l.native === l.name ? l.name : `${l.native} · ${l.name}`}
              selected={language === l.code}
              onPress={() => changeLanguage(l.code)}
            />
          ))}
        </View>
      </Card>

      <Card>
        <Label>1. What should it sound like?</Label>
        {TRAITS.map((g) => (
          <View key={g.group} style={{ gap: space.xs }}>
            <Body muted>{g.group}</Body>
            <View style={styles.wrap}>
              {g.options.map((o) => (
                <Chip key={o} label={o} selected={traits[g.group] === o} onPress={() => toggleTrait(g.group, o)} />
              ))}
            </View>
          </View>
        ))}
        {SPEAKERS[language] && (
          <View style={{ gap: space.xs }}>
            <Body muted>Base voice (optional, steadier results)</Body>
            <View style={styles.wrap}>
              {SPEAKERS[language]?.map((s) => (
                <Chip key={s} label={s} selected={speaker === s} onPress={() => setSpeaker(speaker === s ? null : s)} />
              ))}
            </View>
          </View>
        )}
        <Field
          label="Anything else (in English)"
          value={extra}
          onChangeText={setExtra}
          placeholder="e.g. like a grandmother telling a bedtime story"
          multiline
          maxLength={300}
          style={{ minHeight: 64, textAlignVertical: 'top' }}
        />
        <View style={[styles.desc, { backgroundColor: t.tint }]}>
          <Text style={{ color: t.ink, fontSize: 14, lineHeight: 20 }}>{description}</Text>
        </View>
      </Card>

      <Card>
        <Label>2. Listen</Label>
        <Body muted>
          Each take is a slightly different voice. Make up to {MAX_PREVIEWS} and pick one. It reads a short {lang?.name} line.
        </Body>
        <Button
          title={previews.length ? 'Make another take' : 'Make a take'}
          onPress={preview}
          busy={busy === 'preview'}
          disabled={busy !== null}
        />
        {previews.map((p, i) => (
          <Pressable
            key={p.preview_id}
            accessibilityRole="radio"
            accessibilityState={{ checked: chosen === p.preview_id }}
            onPress={() => setChosen(p.preview_id)}
            style={[
              styles.take,
              { borderColor: chosen === p.preview_id ? t.accent : t.line, backgroundColor: chosen === p.preview_id ? t.tint : 'transparent' },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Body>Take {previews.length - i}</Body>
              <Body muted>
                {p.seconds.toFixed(1)} s · made in {p.render_seconds.toFixed(1)} s
              </Body>
            </View>
            <Button
              title={playing === p.preview_id && status.playing ? 'Pause' : 'Play'}
              kind="secondary"
              small
              onPress={() => void play(p)}
            />
          </Pressable>
        ))}
      </Card>

      <Card>
        <Label>3. Keep it</Label>
        <Body muted>The chosen take becomes this voice's reference, so every line you make sounds exactly like it.</Body>
        {cloneEnginesFor(language).length > 1 && (
          <View style={styles.wrap}>
            {cloneEnginesFor(language).map((e) => (
              <Chip key={e.key} label={`${e.label} · ${e.hint}`} selected={engine === e.key} onPress={() => setEngine(e.key)} />
            ))}
          </View>
        )}
        <Button
          title="Save voice"
          onPress={save}
          busy={busy === 'save'}
          disabled={!chosen || !name.trim() || busy !== null}
        />
        {error && <Notice text={error} kind="error" />}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  desc: { borderRadius: radius.md, padding: space.md },
  take: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
  },
});
