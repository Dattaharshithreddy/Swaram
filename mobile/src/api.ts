/**
 * Client for a Swaram server (see deploy/README.md).
 *
 * The phone never runs a voice model. It uploads recordings, asks the server
 * to clone and speak, and saves the returned audio.
 */
import { File, Paths } from 'expo-file-system';
import type { LanguageCode } from './languages';

export interface ServerConfig {
  url: string;
  apiKey: string;
}

export interface VoiceProfile {
  id: string;
  name: string;
  language: string;
  voice_type: string;
  default_engine: string | null;
  sample_count: number;
  created_at: string;
}

export interface ModelStatus {
  model_name: string;
  display_name: string;
  downloaded: boolean;
  downloading: boolean;
  size_mb: number | null;
}

export interface Health {
  status: string;
  gpu_available: boolean;
  gpu_type: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function headers(cfg: ServerConfig, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', ...extra };
  if (cfg.apiKey.trim()) h.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  return h;
}

/** Turn any server error body (FastAPI or OpenAI style) into one readable line. */
async function readError(res: Response): Promise<ApiError> {
  let message = `Server returned ${res.status}`;
  try {
    const body = await res.json();
    const detail = body?.detail ?? body?.error?.message;
    if (typeof detail === 'string') message = detail;
    else if (Array.isArray(detail) && detail[0]?.msg) message = detail.map((d: { msg: string }) => d.msg).join('; ');
  } catch {
    // not JSON
  }
  if (res.status === 401) message = 'Wrong or missing API key. Check Settings.';
  return new ApiError(message, res.status);
}

async function request<T>(cfg: ServerConfig, path: string, init: RequestInit = {}): Promise<T> {
  if (!cfg.url) throw new ApiError('Add your server URL in Settings first.', 0);
  let res: Response;
  try {
    res = await fetch(normalizeUrl(cfg.url) + path, {
      ...init,
      headers: { ...headers(cfg), ...(init.headers as Record<string, string> | undefined) },
    });
  } catch {
    throw new ApiError('Could not reach the server. Is it running, and is the URL right (https://...)?', 0);
  }
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export const api = {
  health: (cfg: ServerConfig) => request<Health>(cfg, '/health'),

  listVoices: async (cfg: ServerConfig) => {
    const all = await request<VoiceProfile[]>(cfg, '/profiles');
    return all.filter((p) => p.voice_type === 'cloned');
  },

  deleteVoice: (cfg: ServerConfig, id: string) =>
    request<unknown>(cfg, `/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  modelStatus: async (cfg: ServerConfig) =>
    (await request<{ models: ModelStatus[] }>(cfg, '/models/status')).models,

  downloadModel: (cfg: ServerConfig, modelName: string) =>
    request<unknown>(cfg, '/models/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_name: modelName }),
    }),

  /** Speech-to-text for the reference clip, so the user only has to correct it. */
  transcribe: async (cfg: ServerConfig, audioUri: string, language: LanguageCode) => {
    const form = new FormData();
    form.append('file', audioFilePart(audioUri) as unknown as Blob);
    form.append('language', language);
    form.append('model', 'turbo');
    const res = await request<{ text: string; duration: number }>(cfg, '/transcribe', {
      method: 'POST',
      body: form,
    });
    return res;
  },

  /** Create a cloned voice: profile first, then its reference sample. */
  createVoice: async (
    cfg: ServerConfig,
    opts: { name: string; language: LanguageCode; engine: string; audioUri: string; transcript: string },
  ) => {
    const profile = await request<VoiceProfile>(cfg, '/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: opts.name,
        language: opts.language,
        voice_type: 'cloned',
        default_engine: opts.engine,
        description: 'Created in the Swaram app',
      }),
    });
    try {
      const form = new FormData();
      form.append('file', audioFilePart(opts.audioUri) as unknown as Blob);
      form.append('reference_text', opts.transcript);
      await request<unknown>(cfg, `/profiles/${encodeURIComponent(profile.id)}/samples`, {
        method: 'POST',
        body: form,
      });
    } catch (err) {
      // Don't leave an empty voice behind if the sample upload failed.
      await api.deleteVoice(cfg, profile.id).catch(() => undefined);
      throw err;
    }
    return profile;
  },

  /**
   * Generate speech and save it to a local file. Uses the server's
   * OpenAI-compatible endpoint, which returns the audio directly.
   */
  speak: async (cfg: ServerConfig, voiceId: string, text: string): Promise<File> => {
    const generate = async (format: 'mp3' | 'wav') => {
      if (!cfg.url) throw new ApiError('Add your server URL in Settings first.', 0);
      let res: Response;
      try {
        res = await fetch(`${normalizeUrl(cfg.url)}/v1/audio/speech`, {
          method: 'POST',
          headers: headers(cfg, { 'Content-Type': 'application/json', Accept: '*/*' }),
          body: JSON.stringify({ model: 'tts-1', voice: voiceId, input: text, response_format: format }),
        });
      } catch {
        throw new ApiError('Could not reach the server. Check your internet and the server URL.', 0);
      }
      if (!res.ok) throw await readError(res);
      return { bytes: new Uint8Array(await res.arrayBuffer()), format };
    };

    let out: { bytes: Uint8Array; format: 'mp3' | 'wav' };
    try {
      out = await generate('mp3');
    } catch (err) {
      // Servers without MP3 support fall back to WAV.
      if (err instanceof ApiError && /format/i.test(err.message)) out = await generate('wav');
      else throw err;
    }

    const file = new File(Paths.document, `swaram-${Date.now()}.${out.format}`);
    await file.write(out.bytes);
    return file;
  },
};

/** React Native's FormData accepts {uri, name, type} objects for file uploads. */
function audioFilePart(uri: string) {
  const ext = (uri.split('?')[0].split('.').pop() || 'm4a').toLowerCase();
  const type =
    ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : 'audio/mp4';
  return { uri, name: `sample.${ext}`, type };
}

/** Engine model names the server must have downloaded before cloning works. */
export const REQUIRED_MODELS = [
  { model: 'indicf5', label: 'IndicF5 (Indian languages)' },
  { model: 'whisper-turbo', label: 'Whisper (transcription)' },
  { model: 'chatterbox-tts', label: 'Chatterbox (English)' },
];
