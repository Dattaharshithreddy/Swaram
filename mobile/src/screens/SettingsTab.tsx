import Constants from 'expo-constants';
import { useState } from 'react';
import { Alert, Linking, Pressable, Text, View } from 'react-native';
import { SwaramEdge } from '../../modules/swaram-edge';
import { Button, Card, Chip, Field, Header, Icon, Label, Notice, ProgressBar, Row, Screen } from '../components/ui';
import { type Credentials, saveCredentials } from '../edge/kaggleTraining';
import { deleteModel, downloadModel, installedBytes, modelNeedsUpdate } from '../edge/store';
import type { Provider } from '../edge/engine';
import { useServerConfig } from '../settings';
import { QUALITY, useApp } from '../state';
import { font, space, useTheme } from '../theme';
import { friendlyError } from '../errors';
import { StudioQuality } from '../components/StudioQuality';

function mask(s: string) {
  return s ? `••••${s.slice(-4)}` : 'not set';
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <Label>{title}</Label>
      {children}
    </View>
  );
}

const PROVIDERS: { key: Provider; label: string }[] = [
  { key: 'xnnpack', label: 'CPU (XNNPACK)' },
  { key: 'cpu', label: 'CPU (basic)' },
  { key: 'nnapi', label: 'AI chip (NNAPI)' },
];

export function SettingsTab() {
  const t = useTheme();
  const app = useApp();
  const { prefs, updatePrefs } = app;
  const [error, setError] = useState<string | null>(null);
  const [editingKeys, setEditingKeys] = useState(false);
  const [draft, setDraft] = useState<Credentials>({ username: '', token: '', hfToken: '' });
  const [pFrom, setPFrom] = useState('');
  const [pTo, setPTo] = useState('');
  const server = useServerConfig();
  const [crash] = useState<string | null>(() => {
    try {
      return SwaramEdge?.crashReport() ?? null;
    } catch {
      return null;
    }
  });
  const c = app.creds;
  const keysReady = !!c?.username && !!c.token && !!c.hfToken;
  const mb = (b: number) => `${(b / 1e6).toFixed(0)} MB`;

  const download = app.downloads.model;
  const startDownload = () => void app.startDownload('model');

  return (
    <Screen>
      <Header title="Settings" />

      {crash && (
        <Card>
          <Label>The app closed last time</Label>
          <Notice text="If it keeps happening, send a screenshot of this report." />
          <Text selectable style={{ fontFamily: 'monospace', fontSize: 11, color: t.ink }}>
            {crash}
          </Text>
        </Card>
      )}

      <Section title="Offline engine">
        <Card style={{ paddingVertical: 4 }}>
          {app.installed ? (
            <Row
              title="Voice model"
              detail={`Installed · ${mb(installedBytes())}`}
              detailKind="ok"
              right={
                <Button
                  title="Remove"
                  kind="secondary"
                  small
                  onPress={() =>
                    Alert.alert('Remove the voice model?', 'Frees about 450 MB. Big-model voices stop working until you download it again; ⚡ fast voices keep working.', [
                      { text: 'Keep' },
                      {
                        text: 'Remove',
                        style: 'destructive',
                        onPress: async () => {
                          await app.releaseEngine();
                          deleteModel();
                          app.refreshModel();
                        },
                      },
                    ])
                  }
                />
              }
            />
          ) : download?.running ? (
            <View style={{ gap: space.sm, paddingVertical: 14 }}>
              <Text style={{ color: t.ink, fontFamily: font.semibold, fontSize: 14 }}>Downloading the voice model…</Text>
              <ProgressBar value={download.total ? download.bytes / download.total : 0} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Notice text={download.total ? `${mb(download.bytes)} of ${mb(download.total)}` : 'Starting…'} />
                <Button title="Cancel" kind="secondary" small onPress={() => app.cancelDownload('model')} />
              </View>
            </View>
          ) : (
            <View style={{ gap: space.sm, paddingVertical: 14 }}>
              <Text style={{ color: t.ink, fontFamily: font.semibold, fontSize: 14 }}>Voice model</Text>
              <Notice
                text={
                  modelNeedsUpdate()
                    ? 'A faster version is available. Updating downloads about 350 MB; your voices are kept.'
                    : 'Needed to clone voices on this phone. One-time download of about 450 MB, use Wi-Fi.'
                }
              />
              <Button title={modelNeedsUpdate() ? 'Update model' : 'Download model'} icon="download-cloud" onPress={startDownload} />
            </View>
          )}
          <View style={{ gap: space.sm, paddingVertical: 14, borderTopWidth: 1, borderTopColor: t.surface2 }}>
            <Text style={{ color: t.ink, fontFamily: font.semibold, fontSize: 14 }}>Big-model quality</Text>
            <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
              {QUALITY.map((q) => (
                <Chip key={q.steps} label={`${q.label} · ${q.steps}`} selected={prefs.steps === q.steps} onPress={async () => {
                  updatePrefs({ steps: q.steps, studio: false });
                  if (prefs.studio) await app.releaseEngine();
                }} />
              ))}
            </View>
            <Notice text="Fewer steps are faster but rougher. Fast voices don't use this. For the best quality, use Studio render on Kaggle (Studio → open a project)." />
          </View>
          <View style={{ gap: space.sm, paddingVertical: 14, borderTopWidth: 1, borderTopColor: t.surface2 }}>
            <StudioQuality />
          </View>
          <View style={{ gap: space.sm, paddingVertical: 14, borderTopWidth: 1, borderTopColor: t.surface2 }}>
            <Text style={{ color: t.ink, fontFamily: font.semibold, fontSize: 14 }}>Processor</Text>
            <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
              {PROVIDERS.map((p) => (
                <Chip
                  key={p.key}
                  label={p.label}
                  selected={prefs.provider === p.key}
                  onPress={async () => {
                    updatePrefs({ provider: p.key });
                    await app.releaseEngine();
                  }}
                />
              ))}
            </View>
          </View>
        </Card>
        {(error || download?.error) && <Notice text={(error || download?.error) as string} kind="error" />}
      </Section>

      <Section title="Fast voice training (free)">
        <Card style={{ paddingVertical: editingKeys || !keysReady ? undefined : 4 }}>
          {editingKeys || !keysReady ? (
            <View style={{ gap: space.md }}>
              <Notice text="Trains ⚡ fast voices on Kaggle's free GPU. Get a token at kaggle.com/settings/api (Create New Token) and a Hugging Face token at huggingface.co/settings/tokens." />
              <Field label="Kaggle username" value={editingKeys ? draft.username : (c?.username ?? '')} onChangeText={(v) => setDraft({ ...(editingKeys ? draft : (c ?? draft)), username: v })} onFocus={() => !editingKeys && (setDraft(c ?? draft), setEditingKeys(true))} autoCapitalize="none" autoCorrect={false} />
              <Field label="Kaggle API token" value={editingKeys ? draft.token : (c?.token ?? '')} onChangeText={(v) => setDraft({ ...(editingKeys ? draft : (c ?? draft)), token: v })} onFocus={() => !editingKeys && (setDraft(c ?? draft), setEditingKeys(true))} autoCapitalize="none" autoCorrect={false} secureTextEntry />
              <Field label="Hugging Face token" value={editingKeys ? draft.hfToken : (c?.hfToken ?? '')} onChangeText={(v) => setDraft({ ...(editingKeys ? draft : (c ?? draft)), hfToken: v })} onFocus={() => !editingKeys && (setDraft(c ?? draft), setEditingKeys(true))} autoCapitalize="none" autoCorrect={false} secureTextEntry />
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <Button
                  title="Save keys"
                  icon="check"
                  style={{ flex: 1 }}
                  disabled={!draft.username.trim() || !draft.token.trim() || !draft.hfToken.trim()}
                  onPress={async () => {
                    await saveCredentials(draft);
                    app.setCreds({ username: draft.username.trim(), token: draft.token.trim(), hfToken: draft.hfToken.trim() });
                    setEditingKeys(false);
                  }}
                />
                {keysReady && <Button title="Cancel" kind="secondary" onPress={() => setEditingKeys(false)} />}
              </View>
              <Pressable accessibilityRole="link" onPress={() => void Linking.openURL('https://www.kaggle.com/settings/api')}>
                <Text style={{ color: t.accent, fontFamily: font.bold, fontSize: 13 }}>Open Kaggle API settings</Text>
              </Pressable>
              <Notice text="Keys are stored encrypted on this phone and only sent to Kaggle. Training notebooks are private to your account." />
            </View>
          ) : (
            <>
              <Row title="Kaggle account" detail={`${c?.username} · token ${mask(c?.token ?? '')}`} right={<Icon name="check-circle" color={t.ok} />} />
              <Row title="Hugging Face token" detail={mask(c?.hfToken ?? '')} />
              <Row
                title="Change keys"
                last
                onPress={() => {
                  setDraft(c ?? { username: '', token: '', hfToken: '' });
                  setEditingKeys(true);
                }}
              />
            </>
          )}
        </Card>
      </Section>

      <Section title="Pronunciations">
        <Card>
          <Notice text="Words to always say a certain way, e.g. SIP → ఎస్ఐపీ, or a name in Telugu script. Used everywhere." />
          {prefs.pronunciations.map((p, i) => (
            <View key={`${p.from}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Text style={{ color: t.ink, fontFamily: font.semibold, fontSize: 14, flex: 1 }}>{p.from}</Text>
              <Icon name="arrow-right" size={14} color={t.faint} />
              <Text style={{ color: t.ink, fontSize: 15, flex: 1 }}>{p.to}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${p.from}`} onPress={() => updatePrefs({ pronunciations: prefs.pronunciations.filter((_, j) => j !== i) })} style={{ padding: 8 }}>
                <Icon name="x" size={16} color={t.faint} />
              </Pressable>
            </View>
          ))}
          <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-end' }}>
            <View style={{ flex: 1 }}>
              <Field label="Word" value={pFrom} onChangeText={setPFrom} placeholder="SIP" autoCapitalize="none" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Say as" value={pTo} onChangeText={setPTo} placeholder="ఎస్ఐపీ" />
            </View>
          </View>
          <Button
            title="Add"
            icon="plus"
            kind="secondary"
            small
            disabled={!pFrom.trim() || !pTo.trim()}
            onPress={() => {
              updatePrefs({ pronunciations: [...prefs.pronunciations, { from: pFrom.trim(), to: pTo.trim() }] });
              setPFrom('');
              setPTo('');
            }}
          />
        </Card>
      </Section>

      <Section title="Downloads and sharing">
        <Card>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Chip label="M4A · small" selected={prefs.exportFormat === 'm4a'} onPress={() => updatePrefs({ exportFormat: 'm4a' })} />
            <Chip label="WAV · best quality" selected={prefs.exportFormat === 'wav'} onPress={() => updatePrefs({ exportFormat: 'wav' })} />
          </View>
          <Notice text="M4A is about a sixth of the size and plays everywhere, including WhatsApp. Files go to Downloads/Swaram." />
        </Card>
        <Card>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Chip label="Studio finishing on" selected={prefs.polish} onPress={() => updatePrefs({ polish: true })} />
            <Chip label="Off" selected={!prefs.polish} onPress={() => updatePrefs({ polish: false })} />
          </View>
          <Notice text="Cleans up low rumble, adds clarity, evens out loud and quiet parts and sets the volume YouTube and podcasts expect. Applies to new audio." />
        </Card>
      </Section>

      <Section title="GPU server (optional, paid)">
        <Card style={{ paddingVertical: 4 }}>
          <Row
            title={server.config.url ? 'Connected server' : 'Not set up'}
            detail={server.config.url ? server.config.url.replace(/^https?:\/\//, '') : 'Only for instant results from voices that aren’t ⚡ fast yet. Everything else works offline.'}
            onPress={() => app.setPage({ name: 'server' })}
            last
          />
        </Card>
      </Section>

      <Section title="About">
        <Card style={{ paddingVertical: 4 }}>
          <Row title="Swaram" detail={`Version ${Constants.expoConfig?.version ?? '1.0'} · voices stay on this phone`} />
          <Row title="Responsible use" onPress={() => void Linking.openURL('https://github.com/Dattaharshithreddy/Swaram/blob/main/RESPONSIBLE_USE.md')} />
          <Row title="Source code" onPress={() => void Linking.openURL('https://github.com/Dattaharshithreddy/Swaram')} last />
        </Card>
      </Section>
    </Screen>
  );
}
