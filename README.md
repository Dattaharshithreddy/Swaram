<h1 align="center">Swaram · స్వరం</h1>

<p align="center">
  <strong>Local voice cloning and dubbing for English and Indian languages.</strong><br/>
  A focused edition of <a href="https://github.com/jamiepine/voicebox">Voicebox</a> (MIT), rebuilt around Telugu, Hindi, Tamil and 9 more languages.
</p>

---

## What's different from Voicebox

| | Voicebox | Swaram |
|---|---|---|
| Voice languages | 23 (mostly European and East Asian) | **English + 11 Indian**: Hindi, Telugu, Tamil, Kannada, Malayalam, Marathi, Bengali, Gujarati, Odia, Punjabi, Assamese |
| Indian-language cloning engine | none (Hindi only via Chatterbox/Kokoro) | **IndicF5** by AI4Bharat, MIT-licensed, clones in all 11 Indian languages |
| Numbers in Telugu | read as digits | spelled out the way people say them: 2024 → రెండు వేల ఇరవై నాలుగు, ₹1,50,000 → లక్ష యాభై వేలు రూపాయలు, 12% → పన్నెండు శాతం |
| Pronunciation glossary | – | per-language word replacements so brand names and English terms sound the same every time |
| Script check | – | warns when Telugu text was typed in English letters ("namaskaram") |
| Subtitle dubbing | – | translated `.srt` in, one time-aligned dub track out, optional ffmpeg mux into the video |
| Sentence splitting | `.` `!` `?` | also the Devanagari danda `।` `॥` |

Everything else (voice profiles, Whisper transcription, effects, stories, MCP and REST APIs, the desktop app) is Voicebox, unchanged.

## Clone voices from a phone (no laptop, no graphics card)

Voice cloning needs a GPU, so the phone app sends the work to a Swaram server
on a rented cloud GPU and just records, uploads and plays audio.

1. **Server:** rent an Ubuntu GPU machine and run one command. See [deploy/README.md](deploy/README.md).
2. **App:** install the APK from Releases → "Swaram mobile (latest)", then enter the server URL and API key. See [mobile/README.md](mobile/README.md).

On a public server, `SWARAM_API_KEY` must be sent with every request (`Authorization: Bearer <key>`). Without that variable the server stays open, as the local desktop app expects.

## Engines and languages

| Engine | Languages | Licence of weights | Use for |
|---|---|---|---|
| **IndicF5** (new) | hi, te, ta, kn, ml, mr, bn, gu, or, pa, as | MIT (gated download) | Indian-language cloning, **commercial OK** |
| OmniVoice | en + all 11 Indian | CC-BY-NC | personal / testing only |
| Chatterbox | en, hi | MIT | English and Hindi cloning |
| Kokoro | en, hi | Apache-2.0 | fast preset voices |
| Qwen3-TTS, LuxTTS, TADA, Chatterbox Turbo | en | see upstream | English |

Always check a model's own licence before selling work made with it.

## Setup

Requirements: Python 3.12, [Bun](https://bun.sh), [just](https://github.com/casey/just), and ideally an NVIDIA GPU (8 GB+) or an Apple Silicon Mac. CPU works but is slow.

```bash
git clone https://github.com/Dattaharshithreddy/Swaram.git
cd Swaram
just setup        # Python env, all engines (incl. IndicF5), JS deps
just dev          # backend + desktop app
```

### Enable IndicF5 (one time)

IndicF5 is free and MIT-licensed, but the download is gated:

1. Sign in at https://huggingface.co and open https://huggingface.co/ai4bharat/IndicF5.
2. Accept the terms on the model page.
3. Create a read token (Settings → Access Tokens) and run `hf auth login` (older installs: `huggingface-cli login`) in the same Python environment, or set `HF_TOKEN`.
4. In the app: Settings → Models → **IndicF5** → Download (about 1.5 GB).

## Clone a Telugu voice

1. **Record 5–12 seconds** of the speaker talking naturally in Telugu, in a quiet room. Shorter than for other engines: F5 models clone best from one clean sentence or two.
2. Voices → New voice → upload the clip. Set the language to **Telugu**.
3. Make sure the **reference text matches the clip exactly** (Whisper can fill it in; check it). IndicF5 refuses to clone without it, because a wrong transcript produces garbled speech.
4. Set the default engine to **IndicF5** and generate. Write the text in Telugu script.

Get written consent before cloning anyone else's voice.

## Pronunciation glossary

Make terms sound the same in every video:

```bash
curl -X PUT http://127.0.0.1:17493/indic/glossary \
  -H 'Content-Type: application/json' \
  -d '{"te": {"SIP": "ఎస్ఐపీ", "mutual fund": "మ్యూచువల్ ఫండ్"}, "*": {"AI": "ఏఐ"}}'
```

`"*"` entries apply to every language. Whole words only; Telugu suffixes still match (`SIPలో` → `ఎస్ఐపీలో`). The glossary lives in `<data dir>/glossary.json`.

Preview exactly what the voice will be asked to say:

```bash
curl -X POST http://127.0.0.1:17493/indic/prepare \
  -H 'Content-Type: application/json' \
  -d '{"text": "2024లో SIP రాబడి 12%", "language": "te"}'
```

## Dub a video from subtitles

1. Get the original subtitles (YouTube Studio → Subtitles → download `.srt`, or Whisper).
2. Translate each line into Telugu and proofread it. Keep the timestamps.
3. Run:

```bash
python scripts/swaram_dub.py episode14.te.srt --profile "Priya" --language te --engine indicf5
# or straight into the video as a second audio track:
python scripts/swaram_dub.py episode14.te.srt --profile "Priya" --language te --video episode14.mp4
```

Each line starts at its subtitle time. Lines that run long are sped up (pitch kept) by up to 1.25× (`--max-speedup`, max 1.6). If a line still doesn't fit it is pushed later rather than talking over the next one, and the report lists it so you can shorten the translation. A failed line is left silent and reported instead of stopping the render.

Outputs: `episode14.te.wav`, `episode14.te.report.json`, and with `--video`, `episode14.dubbed.mp4` (original audio kept as track 1, Telugu as track 2; `--replace-audio` to swap instead). Upload the WAV to YouTube as an additional audio language, or use the muxed MP4.

## New API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/indic/languages` | languages with their script and the engines that speak them |
| GET / PUT | `/indic/glossary` | read / replace the pronunciation glossary |
| POST | `/indic/prepare` | text after glossary + number spelling, plus script warnings |
| POST | `/dub/srt` | multipart: `file` (.srt), `profile`, `language`, `engine`, `max_speedup` → `audio/wav`, summary in `X-Swaram-Report` |

The full Voicebox API is documented at http://127.0.0.1:17493/docs when the server is running.

## Known limits

- Number spelling is built for **Telugu** (hand-written) and Bengali (via num2words). Other Indian languages keep digits; write numbers as words in the script if a voice misreads them.
- Whisper has no Odia model, so Odia reference clips need a typed transcript.
- IndicF5 was tested here against a fake model only (no GPU in the build environment). Run one real clone after setup and open an issue if the remote model's interface has changed.
- The upstream docs in `docs/` still describe Voicebox's original language set.

## Credits

- [Voicebox](https://github.com/jamiepine/voicebox) by Jamie Pine and contributors (MIT). Original README: [VOICEBOX_README.md](VOICEBOX_README.md).
- [IndicF5](https://github.com/AI4Bharat/IndicF5) by AI4Bharat, IIT Madras, built on [F5-TTS](https://github.com/SWivid/F5-TTS).

Licensed under the MIT License (see [LICENSE](LICENSE)).
