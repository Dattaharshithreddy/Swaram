import { useCallback, useEffect, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { Body, Button, Card, Field, Label, Notice } from '../components/ui';
import {
  checkTraining,
  type Credentials,
  forgetTraining,
  listTrainings,
  loadCredentials,
  saveCredentials,
  startTraining,
  type Training,
} from '../edge/kaggleTraining';
import type { OfflineVoice } from '../edge/store';
import { hasRecording } from '../edge/store';
import { radius, space, useTheme } from '../theme';

/**
 * "Train fast voice": sends the selected voice to Kaggle's free GPU, then
 * checks back and imports the finished ⚡ voice automatically.
 */
export function KaggleTrain({ voice, onImported }: { voice: OfflineVoice | undefined; onImported: () => void }) {
  const t = useTheme();
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [editing, setEditing] = useState(false);
  const [trainings, setTrainings] = useState<Training[]>(() => listTrainings());
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadCredentials().then(setCreds);
  }, []);

  const ready = !!creds?.username && !!creds.token && !!creds.hfToken;

  const checkAll = useCallback(async () => {
    const c = creds ?? (await loadCredentials());
    if (!c.token) return;
    setChecking(true);
    let imported = false;
    try {
      for (const tr of listTrainings().filter((x) => x.state === 'running')) {
        try {
          const next = await checkTraining(tr, c);
          if (next.state === 'done') imported = true;
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      setTrainings(listTrainings());
      setChecking(false);
      if (imported) onImported();
    }
  }, [creds, onImported]);

  // Check running trainings when the screen opens.
  useEffect(() => {
    if (creds?.token && listTrainings().some((x) => x.state === 'running')) void checkAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creds?.token]);

  async function start() {
    if (!voice || !creds) return;
    setBusy(true);
    setError(null);
    try {
      await startTraining(voice, creds);
      setTrainings(listTrainings());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Label>⚡ Personal fast voice (free, on Kaggle)</Label>
      <Body muted>
        Trains a small model of this voice on Kaggle's free GPU (about 4 hours). Your phone can be off meanwhile; when
        it's done, the ⚡ voice appears here and speaks about 20 times faster than real time.
      </Body>

      {(!ready || editing) && creds && (
        <View style={{ gap: space.sm }}>
          <Field
            label="Kaggle username"
            value={creds.username}
            onChangeText={(v) => setCreds({ ...creds, username: v })}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Field
            label="Kaggle API token (kaggle.com/settings/api → Create New Token)"
            value={creds.token}
            onChangeText={(v) => setCreds({ ...creds, token: v })}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <Field
            label="Hugging Face token (huggingface.co/settings/tokens)"
            value={creds.hfToken}
            onChangeText={(v) => setCreds({ ...creds, hfToken: v })}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <Text style={{ color: t.accent, fontWeight: '600' }} onPress={() => void Linking.openURL('https://www.kaggle.com/settings/api')}>
            Open Kaggle API settings
          </Text>
          <Button
            title="Save keys"
            onPress={async () => {
              await saveCredentials(creds);
              setEditing(false);
            }}
            disabled={!creds.username.trim() || !creds.token.trim() || !creds.hfToken.trim()}
          />
          <Notice text="Keys are stored encrypted on this phone and only sent to Kaggle. The notebook is private to your account." />
        </View>
      )}

      {ready && !editing && (
        <>
          {voice && hasRecording(voice) ? (
            <Button title={`Train fast voice: ${voice.name}`} onPress={start} busy={busy} />
          ) : (
            <Notice text={voice ? 'This voice has no saved recording (made before this update). Create it again to train it.' : 'Select an offline voice above.'} />
          )}
          <Text style={{ color: t.accent, fontWeight: '600' }} onPress={() => setEditing(true)}>
            Change keys
          </Text>
        </>
      )}
      {error && <Notice text={error} kind="error" />}

      {trainings.length > 0 && (
        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Label>Trainings</Label>
            {trainings.some((x) => x.state === 'running') && (
              <Text style={{ color: t.accent, fontWeight: '600' }} onPress={checkAll}>
                {checking ? 'Checking…' : 'Check now'}
              </Text>
            )}
          </View>
          {trainings.map((tr) => (
            <View key={tr.id} style={{ borderWidth: 1, borderColor: t.line, borderRadius: radius.md, padding: space.md, gap: 4 }}>
              <Text style={{ color: t.ink, fontWeight: '700' }}>
                {tr.state === 'done' ? '✅' : tr.state === 'failed' ? '⚠️' : '⏳'} {tr.voiceName}
              </Text>
              <Text style={{ color: tr.state === 'failed' ? t.danger : t.soft, fontSize: 13 }}>{tr.detail}</Text>
              <View style={{ flexDirection: 'row', gap: space.md }}>
                {tr.url && (
                  <Text style={{ color: t.accent, fontWeight: '600' }} onPress={() => void Linking.openURL(tr.url as string)}>
                    Open on Kaggle
                  </Text>
                )}
                {tr.state !== 'running' && (
                  <Text
                    style={{ color: t.soft, fontWeight: '600' }}
                    onPress={() => {
                      forgetTraining(tr);
                      setTrainings(listTrainings());
                    }}
                  >
                    Remove
                  </Text>
                )}
              </View>
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}
