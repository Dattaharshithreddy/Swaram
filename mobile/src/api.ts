/**
 * Client for a Swaram server (see deploy/README.md).
 *
 * The phone never runs a voice model. It uploads recordings, asks the server
 * to clone and speak, and saves the returned audio.
 */
import { File, Paths, UploadType } from 'expo-file-system';
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

export type Quality = 'fast' | 'balanced' | 'studio';

/** Engines that clone a voice on the server. */
export type CloneEngine = 'indicf5' | 'dhvaani' | 'chatterbox';

export interface DesignPreview {
  preview_id: string;
  audio_url: string;
  description: string;
  text: string;
  seconds: number;
  render_seconds: number;
  /** Local copy of the preview audio, for playback. */
  uri: string;
}

/** Something the server made: from the app, the desktop app, or Claude. */
export interface Generation {
  id: string;
  profile_name: string;
  text: string;
  language: string;
  duration: number | null;
  engine: string | null;
  status: string;
  error: string | null;
  created_at: string;
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

/**
 * The server's base address. Forgives a pasted page address such as
 * ".../health" or ".../docs" and trailing slashes, which otherwise send every
 * request to the web app's page instead of the API.
 */
export function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\s+/g, '');
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/[?#].*$/, '');
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/(health|docs|mcp|openapi\.json)(\/.*)?$/i, '');
  return u.replace(/\/+$/, '');
}

function networkMessage(err: unknown): string {
  const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
  return `Could not reach the server${detail}. Is it running, and is the URL right (https://...)?`;
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

const NOT_API =
  'The server answered with a web page instead of data. Check the Server URL is only https://….trycloudflare.com, with nothing after .com.';

/** Turns a JSON body into a value, or explains why it isn't JSON. */
function parseJson<T>(text: string, contentType: string | null): T {
  if ((contentType ?? '').includes('text/html') || /^\s*</.test(text)) throw new ApiError(NOT_API, 200);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new ApiError(`The server sent something unexpected: ${text.slice(0, 120)}`, 200);
  }
}

/** file:// URI for a recording or picked file (some recorders return a bare path). */
function fileUri(uri: string): string {
  return uri.startsWith('/') ? `file://${uri}` : uri;
}

function mimeFor(uri: string): string {
  const ext = (uri.split('?')[0].split('.').pop() || 'm4a').toLowerCase();
  return ext === 'wav' ? 'audio/wav' : ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : 'audio/mp4';
}

/**
 * Upload a local audio file as multipart form data with the native uploader.
 * React Native's FormData file parts fail on some Android builds before the
 * request ever reaches the server, so audio never goes through fetch.
 */
async function uploadFile<T>(cfg: ServerConfig, path: string, uri: string, parameters: Record<string, string>): Promise<T> {
  if (!cfg.url) throw new ApiError('Add your server URL in Settings first.', 0);
  const file = new File(fileUri(uri));
  if (!file.exists) throw new ApiError('The recording is missing on this phone. Record or pick it again.', 0);
  let res: { status: number; body: string; headers: Record<string, string> };
  try {
    res = await file.upload(normalizeUrl(cfg.url) + path, {
      httpMethod: 'POST',
      uploadType: UploadType.MULTIPART,
      fieldName: 'file',
      mimeType: mimeFor(uri),
      parameters,
      headers: headers(cfg),
    });
  } catch (err) {
    throw new ApiError(`Could not upload the recording${err instanceof Error && err.message ? ` (${err.message})` : ''}.`, 0);
  }
  const contentType = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? null;
  if (res.status === 401) throw new ApiError('Wrong or missing API key. Check Settings.', 401);
  if (res.status < 200 || res.status >= 300) {
    let message = `Server returned ${res.status}`;
    try {
      const body = JSON.parse(res.body);
      const detail = body?.detail;
      if (typeof detail === 'string') message = detail;
      else if (Array.isArray(detail) && detail[0]?.msg) message = detail.map((d: { msg: string }) => d.msg).join('; ');
    } catch {
      // not JSON
    }
    throw new ApiError(message, res.status);
  }
  return parseJson<T>(res.body, contentType);
}

async function request<T>(cfg: ServerConfig, path: string, init: RequestInit = {}): Promise<T> {
  if (!cfg.url) throw new ApiError('Add your server URL in Settings first.', 0);
  let res: Response;
  try {
    res = await fetch(normalizeUrl(cfg.url) + path, {
      ...init,
      headers: { ...headers(cfg), ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (err) {
    throw new ApiError(networkMessage(err), 0);
  }
  if (!res.ok) throw await readError(res);
  return parseJson<T>(await res.text(), res.headers.get('content-type'));
}

/**
 * Download an audio file from the server (with the API key) to a local file.
 * ``name`` without an extension gets one from the response type.
 */
async function fetchAudio(cfg: ServerConfig, path: string, name: string): Promise<File> {
  let res: Response;
  try {
    res = await fetch(normalizeUrl(cfg.url) + path, { headers: headers(cfg, { Accept: '*/*' }) });
  } catch (err) {
    throw new ApiError(networkMessage(err), 0);
  }
  if (!res.ok) throw await readError(res);
  if (!/\.[a-z0-9]+$/i.test(name)) {
    const type = res.headers.get('content-type') ?? '';
    name += type.includes('mpeg') ? '.mp3' : type.includes('mp4') ? '.m4a' : '.wav';
  }
  const file = new File(Paths.cache, name);
  await file.write(new Uint8Array(await res.arrayBuffer()));
  return file;
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
  transcribe: (cfg: ServerConfig, audioUri: string, language: LanguageCode) =>
    uploadFile<{ text: string; duration: number }>(cfg, '/transcribe', audioUri, { language, model: 'turbo' }),

  /** Everything the server has made, newest first (includes audio Claude made). */
  listGenerations: async (cfg: ServerConfig, limit = 50) =>
    (await request<{ items: Generation[]; total: number }>(cfg, `/history?limit=${limit}`)).items,

  /** Local copy of a generation's audio; downloaded once, then reused. */
  generationAudio: async (cfg: ServerConfig, id: string): Promise<File> => {
    for (const ext of ['wav', 'mp3', 'm4a']) {
      const cached = new File(Paths.cache, `generation-${id}.${ext}`);
      if (cached.exists) return cached;
    }
    return fetchAudio(cfg, `/audio/${encodeURIComponent(id)}`, `generation-${id}`);
  },

  deleteGeneration: (cfg: ServerConfig, id: string) =>
    request<unknown>(cfg, `/history/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Speed/quality preset the server uses for IndicF5 and DhVaani. */
  getQuality: async (cfg: ServerConfig) => (await request<{ quality: Quality }>(cfg, '/indic/quality')).quality,

  setQuality: async (cfg: ServerConfig, quality: Quality) =>
    (
      await request<{ quality: Quality }>(cfg, '/indic/quality', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quality }),
      })
    ).quality,

  /** Render a voice from a written description (Indic Parler-TTS). Nothing is saved. */
  previewDesign: async (
    cfg: ServerConfig,
    opts: { description: string; language: LanguageCode; speaker?: string; seed?: number; text?: string },
  ): Promise<DesignPreview> => {
    const res = await request<Omit<DesignPreview, 'uri'>>(cfg, '/indic/design/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const file = await fetchAudio(cfg, res.audio_url, res.preview_id);
    return { ...res, uri: file.uri };
  },

  /**
   * Save a described voice. It is "locked": the chosen preview becomes the
   * voice's reference clip, so every line keeps exactly this voice.
   */
  saveDesign: (
    cfg: ServerConfig,
    opts: { name: string; description: string; language: LanguageCode; previewId: string; engine: CloneEngine; text: string },
  ) =>
    request<{ profile: VoiceProfile }>(cfg, '/indic/design', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: opts.name,
        description: opts.description,
        language: opts.language,
        preview_id: opts.previewId,
        lock: true,
        lock_engine: opts.engine,
        text: opts.text,
      }),
    }),

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
      await uploadFile<unknown>(cfg, `/profiles/${encodeURIComponent(profile.id)}/samples`, opts.audioUri, {
        reference_text: opts.transcript,
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
      } catch (err) {
        throw new ApiError(networkMessage(err), 0);
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

/** Engine model names the server must have downloaded before cloning works. */
export const REQUIRED_MODELS = [
  { model: 'indicf5', label: 'IndicF5 (Indian languages)' },
  { model: 'whisper-turbo', label: 'Whisper (transcription)' },
  { model: 'chatterbox-tts', label: 'Chatterbox (English)' },
];

/** Optional models: faster cloning and describing a voice in words. */
export const OPTIONAL_MODELS = [
  { model: 'dhvaani', label: 'DhVaani (faster cloning)' },
  { model: 'indic-parler-tts', label: 'Indic Parler-TTS (describe a voice)' },
];
