# Swaram mobile

Clone a voice and make it speak Telugu, Hindi, English and 9 more Indian
languages, from an ordinary Android phone.

The phone does no voice processing. It records, uploads and plays audio; your
Swaram server on a cloud GPU does the cloning (set it up with
[`deploy/README.md`](../deploy/README.md)). So any phone works, with the same
quality as a powerful PC.

## Install

Every push to `main` that touches `mobile/` builds an APK on GitHub:

**Releases → "Swaram mobile (latest)" → `swaram-latest.apk`**

Open that link on the phone, install, and allow "install unknown apps" when
Android asks. (You can also run the "Mobile APK" workflow by hand from the
Actions tab.)

## Use

1. **Settings:** paste the server URL and API key that the setup script printed → *Save and test*. Download any model the screen marks as missing.
2. **Voices → Clone a new voice:** name, language, then record 5–12 seconds reading the sentence on screen. Tap *Fill in automatically*, fix the transcript so it matches the recording word for word, tick the consent box, *Create voice*.
3. **Speak:** pick the voice, type the text in that language's script, *Generate*. Play it, or *Share* to WhatsApp, Drive and so on.

**Offline tab (beta):** no server at all. Download the model once (~450 MB, from the `edge-model` release made by the "Edge model" workflow), record 5–12 seconds reading the sentence shown, and generate on the phone. After each run it shows how fast your phone is. See [edge/README.md](../edge/README.md).

New voices use **IndicF5** for Indian languages and **Chatterbox** for English. Numbers, ₹ and % in Telugu are spelled out by the server, and the server's pronunciation glossary applies.

## Develop

```bash
cd mobile
npm install
npx expo start          # needs a development build: npx expo run:android
npm run typecheck
```

- Expo SDK 58, React Native 0.88, TypeScript. Native folders are generated (`npx expo prebuild`), never edited by hand.
- Three tabs kept in plain state rather than Expo Router; move to Expo Router if the app grows past a handful of screens.
- Server calls are in `src/api.ts`: `/profiles`, `/profiles/{id}/samples`, `/transcribe`, `/models/*`, and the OpenAI-compatible `/v1/audio/speech` for generation. Every request sends `Authorization: Bearer <API key>`.
- The server URL and key are stored with `expo-secure-store`. Generated audio is saved in the app's document folder.

## Play Store

The GitHub APK is signed with a debug key, which is fine for installing
directly but not for the Play Store. For a store build use EAS:

```bash
npx eas-cli@latest build --platform android --profile production
```
