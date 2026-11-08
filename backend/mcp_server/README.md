# Swaram MCP server

Local **Model Context Protocol** server — lets Claude (Code or Desktop) and
any other MCP-aware agent **design new voices from a description**, clone
voices from a recording, read text in them, transcribe audio, and browse
captures.

The server runs inside the same `uvicorn` process as the rest of Voicebox
and is mounted at `/mcp` (Streamable HTTP transport).

## Install into your agent

Claude Code:

```bash
claude mcp add --transport http swaram http://127.0.0.1:17493/mcp --header "X-Voicebox-Client-Id: claude-code"
```

Remote GPU server with `SWARAM_API_KEY` set: use its URL and add
`--header "Authorization: Bearer <key>"`.

Any client that takes JSON config (Claude Desktop via a connector, Cursor, …):

```json
{
  "mcpServers": {
    "swaram": {
      "url": "http://127.0.0.1:17493/mcp",
      "headers": { "X-Voicebox-Client-Id": "claude-desktop" }
    }
  }
}
```

Fallback — stdio shim (when the client doesn't speak HTTP MCP). The
`voicebox-mcp` binary ships inside the Voicebox.app bundle:

```json
{
  "mcpServers": {
    "voicebox": {
      "command": "/Applications/Voicebox.app/Contents/MacOS/voicebox-mcp",
      "env": { "VOICEBOX_CLIENT_ID": "claude-code" }
    }
  }
}
```

## Tools

### Swaram tools (voice design and cloning)

| Name | Purpose |
|---|---|
| `swaram_voice_design_guide` | How to describe a voice, recommended speaker names per language, sample text. |
| `swaram_preview_voice`      | Description → WAV to listen to. Nothing is saved. Try a few seeds. |
| `swaram_design_voice`       | Save a described voice. `lock=true` (default) renders a sample once and saves a cloned voice, so every line sounds identical. Pass `preview_audio_path` to keep a preview you liked. |
| `swaram_clone_voice`        | Clone from a recording (`audio_path` on the server, or `audio_base64`). Whisper fills the transcript if omitted (not Odia). |
| `swaram_speak`              | Read text in a voice and wait for the WAV (path, URL, duration). `quality` = fast / balanced / studio. |
| `swaram_get_audio`          | Poll a `swaram_speak(wait=false)` generation. |
| `swaram_compare_engines`    | Same text, one voice, several engines (default IndicF5 vs DhVaani), with timings. |
| `swaram_set_quality`        | Server-wide speed/quality preset for IndicF5 and DhVaani. |
| `swaram_list_voices`        | Saved voices with language, type and default engine. |

Paths in results are on the machine running the server; `audio_url` is the
same file over HTTP (prefix the server URL).

Designing voices needs Indic Parler-TTS (`just setup-parler`, plus accepting
its terms on Hugging Face). English designs use Qwen VoiceDesign.

Example prompts:

- "Create a Hindi news-anchor voice: confident man, crisp, medium pace. Show me 3 options."
- "Save option 2 as Rohit-News and read today's headlines in it: …"
- "Clone my voice from /home/me/clip.wav, it's Telugu."

### Original Voicebox tools

| Name | Purpose |
|---|---|
| `voicebox_speak`          | Speak text in a voice profile. Returns a generation id you can poll. |
| `voicebox_transcribe`     | Whisper transcription of a base64 blob or an absolute local path. |
| `voicebox_list_captures`  | Recent captures (dictation / recording / file) with transcripts. |
| `voicebox_list_profiles`  | Available voice profiles (cloned + preset). |

All tools resolve voice profiles in this precedence:

1. Explicit `profile` arg (name or id — case-insensitive)
2. Per-client binding keyed by `X-Voicebox-Client-Id`
3. `capture_settings.default_playback_voice_id` (global default)

Bindings are managed via `GET|PUT /mcp/bindings` or in the app under
Settings → MCP.

## Debug with MCP Inspector

```
npx @modelcontextprotocol/inspector http://127.0.0.1:17493/mcp
```

Point it at the URL, hit "List tools," call `voicebox_list_profiles`
first to confirm wiring, then `voicebox_speak` for end-to-end.

## Non-MCP REST surface

`POST /speak` is a thin wrapper on the same code path for callers that
don't speak MCP (shell scripts, ACP, A2A):

```
curl -X POST http://127.0.0.1:17493/speak \
  -H 'Content-Type: application/json' \
  -H 'X-Voicebox-Client-Id: claude-code' \
  -d '{"text":"Build complete.","profile":"Morgan"}'
```

## Code layout

```
backend/mcp_server/
├── __init__.py      # re-export mount_into
├── server.py        # build_mcp_server() + mount_into(app)
├── tools.py         # voicebox_* tools (speak, transcribe, captures, profiles)
├── swaram_tools.py  # swaram_* tools (design, clone, speak-and-wait, compare)
├── context.py       # ClientIdMiddleware + current_client_id ContextVar
├── resolve.py       # profile resolution precedence
├── events.py        # pub/sub queue for /events/speak pill SSE
└── README.md        # you are here

backend/mcp_shim/    # stdio ↔ Streamable-HTTP proxy (see its README)
```

The package is **`mcp_server`**, not `mcp`, to avoid shadowing the
installed `mcp` PyPI package that FastMCP imports internally.
