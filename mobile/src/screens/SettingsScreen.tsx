import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { api, type ModelStatus, REQUIRED_MODELS, type ServerConfig } from '../api';
import { Body, Button, Card, Field, Label, Notice, Title } from '../components/ui';
import { space } from '../theme';
import { friendlyError } from '../errors';

export function SettingsScreen({
  config,
  onSave,
}: {
  config: ServerConfig;
  onSave: (next: ServerConfig) => Promise<ServerConfig>;
}) {
  const [url, setUrl] = useState(config.url);
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  const [models, setModels] = useState<ModelStatus[] | null>(null);

  useEffect(() => {
    setUrl(config.url);
    setApiKey(config.apiKey);
  }, [config]);

  async function saveAndTest() {
    setBusy(true);
    setMessage(null);
    try {
      if (!/^https:\/\//i.test(url.trim()) && !/^http:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.trim())) {
        throw new Error('Use the https:// address the setup script printed.');
      }
      const saved = await onSave({ url, apiKey });
      const health = await api.health(saved);
      await api.listVoices(saved); // proves the API key works
      setModels(await api.modelStatus(saved));
      setMessage({
        kind: 'ok',
        text: `Connected. ${health.gpu_available ? `GPU: ${health.gpu_type ?? 'yes'}` : 'No GPU detected: generation will be very slow.'}`,
      });
    } catch (e) {
      setMessage({ kind: 'error', text: friendlyError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function download(model: string) {
    try {
      await api.downloadModel(config, model);
      setMessage({ kind: 'ok', text: 'Download started on the server. Check back in a few minutes.' });
      setModels(await api.modelStatus(config));
    } catch (e) {
      setMessage({ kind: 'error', text: friendlyError(e) });
    }
  }

  const required = REQUIRED_MODELS.map((r) => ({ ...r, status: models?.find((m) => m.model_name === r.model) }));

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Title>Server</Title>
      <Card>
        <Body muted>
          Voices are cloned on your Swaram server, not on this phone. Enter the URL and API key that
          deploy/setup-gpu-vm.sh printed.
        </Body>
        <Field
          label="Server URL"
          value={url}
          onChangeText={setUrl}
          placeholder="https://your-server.trycloudflare.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Field
          label="API key"
          value={apiKey}
          onChangeText={setApiKey}
          placeholder="40-character key"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Button title="Save and test" onPress={saveAndTest} busy={busy} disabled={!url.trim()} />
        {message && <Notice text={message.text} kind={message.kind} />}
      </Card>

      {models && (
        <Card>
          <Label>Models on the server</Label>
          {required.map((r) => (
            <View
              key={r.model}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}
            >
              <View style={{ flex: 1 }}>
                <Body>{r.label}</Body>
                <Notice
                  text={
                    r.status?.downloaded
                      ? 'Ready'
                      : r.status?.downloading
                        ? 'Downloading…'
                        : r.status
                          ? 'Not downloaded'
                          : 'Not available on this server'
                  }
                  kind={r.status?.downloaded ? 'ok' : 'info'}
                />
              </View>
              {r.status && !r.status.downloaded && !r.status.downloading && (
                <Button title="Download" kind="secondary" onPress={() => download(r.model)} />
              )}
            </View>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}
