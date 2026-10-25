/**
 * End-to-end check of the offline engine, started by opening
 * swaram://selftest (CI does this on an Android emulator; see
 * .github/workflows/mobile-apk.yml). It follows the same path as a user:
 * download the model, load it, make a voice from a clip, save and reload
 * the voice, then speak. Progress goes to the log as "SWARAM_SELFTEST ...".
 */
import { SwaramEdge } from '../../modules/swaram-edge';
import { encodeWav, SAMPLE_RATE } from './dsp';
import { EdgeEngine, type Provider } from './engine';
import { File, Paths } from 'expo-file-system';
import { addMusic, createDubJob, createScriptJob, f5Maker, fastMaker, finalAudio, musicFile, withGain, jobVoiceKeys, type MakerFor, outputFile, type PartMaker, partsDone, redoPart, runJob, srtFile } from './jobs';
import { replaceWords } from './textrules';
import { deletePersonal, FastVoice, importPersonal } from './personal';
import { EMOTION_STYLE } from './emotions';
import { writeFloats } from './engine';
import { importSound } from './sounds';
import { exportVoice, importVoice } from './voices';
import { downloadModel, exportForTraining, loadEmotionData, loadVoiceData, saveEmotion, modelDir, modelInstalled, saveAudio, saveVoice } from './store';
import { prepareText } from './telugu';
import { spokenText } from '../translit';

const TEST_PACK_URL = 'https://github.com/Dattaharshithreddy/Swaram/releases/download/personal-voice-test/swaram-voice-CI-test.zip';

function log(msg: string) {
  console.log(`SWARAM_SELFTEST ${msg}`);
}

/** A voice-like test clip: a gliding pitch with harmonics and syllable rhythm. */
function testClip(seconds: number): Float32Array {
  const n = Math.floor(seconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const f0 = 140 + 25 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += (2 * Math.PI * f0) / SAMPLE_RATE;
    let s = 0;
    for (let h = 1; h <= 8; h++) s += Math.sin(h * phase) / h;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    out[i] = 0.15 * s * env + 0.005 * (Math.random() - 0.5);
  }
  return out;
}

export async function runSelfTest(provider: Provider = 'xnnpack'): Promise<void> {
  try {
    log(`start provider=${provider}`);
    const report = SwaramEdge?.crashReport();
    if (report) log(`previous crash: ${report.replace(/\n/g, ' | ')}`);
    if (!SwaramEdge) throw new Error('native module missing');

    if (!modelInstalled()) {
      log('downloading model');
      let lastPct = -10;
      await downloadModel((bytes, total) => {
        const pct = total ? Math.floor((bytes / total) * 100) : 0;
        if (pct >= lastPct + 10) {
          lastPct = pct;
          log(`download ${pct}%`);
        }
      });
    }
    if (!modelInstalled()) throw new Error('model files incomplete after download');

    const engine = await EdgeEngine.load(modelDir(), provider);
    log(`loaded in ${engine.loadSeconds.toFixed(1)} s`);

    const data = await engine.makeVoice(testClip(6), 'నమస్కారం, ఈ రోజు వాతావరణం చాలా బాగుంది.');
    log(`voice made frames=${data.frames}`);
    const clip = testClip(6);
    const saved = saveVoice('Self test', 'te', data, clip);
    const reloaded = await loadVoiceData(saved);
    log(`voice saved and reloaded frames=${reloaded.frames}`);

    // English words inside Telugu are spelled the way Telugu speakers say them.
    const mixed = spokenText('Space లో satellites తిరుగుతాయి, gravity ఉండదు.', 'te');
    if (mixed !== 'స్పేస్ లో శాటిలైట్స్ తిరుగుతాయి, గ్రావిటీ ఉండదు.') throw new Error(`english words: ${mixed}`);
    log(`english words ok: ${mixed}`);
    const t0 = Date.now();
    const { wav, timing } = await engine.speak(reloaded, prepareText(spokenText('Idi oka pariksha. 25 rupayalu.', 'te'), 'te'), {
      steps: 4,
      guidance: 0.5, // exercises both the guided and the single-branch step
      onProgress: (done, total) => log(`step ${done}/${total}`),
    });
    const file = saveAudio(encodeWav(wav));
    const wall = (Date.now() - t0) / 1000;
    let peak = 0;
    let finite = true;
    for (const s of wav) {
      if (!Number.isFinite(s)) finite = false;
      peak = Math.max(peak, Math.abs(s));
    }
    if (!finite || wav.length === 0) throw new Error(`bad audio: samples=${wav.length} finite=${finite}`);
    log(
      `speak ok audio=${timing.audioSeconds.toFixed(2)}s wall=${wall.toFixed(1)}s context=${timing.contextSeconds.toFixed(2)}s ` +
        `steps=${timing.stepSeconds.toFixed(1)}s vocoder=${timing.vocoderSeconds.toFixed(2)}s peak=${peak.toFixed(3)} file=${file.uri}`,
    );
    // Upload path: decode an audio file (a WAV made here) back to 24 kHz.
    const upload = new File(Paths.cache, 'selftest-upload.wav');
    upload.writeSync(encodeWav(testClip(5)));
    const decoded = new File(Paths.cache, 'selftest-upload.f32');
    if (decoded.exists) decoded.delete();
    const n = await SwaramEdge.decodeAudio(upload.uri, decoded.uri, 600);
    log(`decoded upload samples=${n}`);
    if (Math.abs(n - 5 * SAMPLE_RATE) > SAMPLE_RATE / 10) throw new Error(`decode length ${n}`);

    // Export for training (zip of the recording + its words).
    const exported = await exportForTraining(saved);
    log(`export for training ${new File(exported).size} bytes`);

    // Personal fast voice: CI's test pack (noise, but the same format and model shape).
    const pack = new File(Paths.cache, 'selftest-voice.zip');
    if (pack.exists) pack.delete();
    await File.downloadFileAsync(TEST_PACK_URL, pack);
    const pv = await importPersonal(pack.uri);
    const fast = await FastVoice.load(pv);
    const fastOut = await fast.speak(prepareText('ఈ రోజు వాతావరణం చాలా బాగుంది. మనం బయటికి వెళ్దాం.', 'te'));
    log(`fast voice audio=${(fastOut.wav.length / SAMPLE_RATE).toFixed(2)}s in ${fastOut.seconds.toFixed(2)}s load=${fast.loadSeconds.toFixed(2)}s`);
    if (fastOut.wav.length < SAMPLE_RATE / 2 || !fastOut.wav.every(Number.isFinite)) throw new Error('fast voice output bad');

    // Emotion recording for the big-model voice (a lower, slower clip stands in for "sad").
    const sadClip = testClip(5).map((v, i) => v * (0.6 + 0.2 * Math.sin(i / 3000)));
    const sadData = await engine.makeVoice(sadClip, 'ఇలా జరుగుతుందని అనుకోలేదు. మనసంతా బరువుగా ఉంది.');
    const withSad = saveEmotion(saved, 'sad', sadData, sadClip);
    log(`emotion saved: ${Object.keys(withSad.emotions ?? {}).join(',')} fast voice knows: ${(pv.emotions ?? []).join(',') || 'none'}`);

    // Multi-voice script with emotions: big-model voice ("Self test") and fast voice ("CI test").
    const opts = { steps: 2, guidance: 0.5, speed: 1 };
    const used: string[] = [];
    const makerFor: MakerFor = async (key, emotion) => {
      const style = emotion ? EMOTION_STYLE[emotion] : null;
      if (key === `fast:${pv.id}`) {
        used.push(`fast:${emotion ?? 'normal'}:${fast.knows(emotion) ? 'token' : 'style'}`);
        return fast.knows(emotion) ? fastMaker(fast, 1, emotion) : withGain(fastMaker(fast, style?.speed ?? 1), style?.gain ?? 1);
      }
      if (key === `f5:${saved.id}`) {
        const take = emotion ? await loadEmotionData(withSad, emotion) : null;
        used.push(`f5:${emotion ?? 'normal'}:${take ? 'recording' : emotion ? 'style' : 'normal'}`);
        return take
          ? f5Maker(engine, take, opts, `cond-selftest-${emotion}`)
          : withGain(f5Maker(engine, reloaded, { ...opts, speed: style?.speed ?? 1 }, 'cond-selftest'), style?.gain ?? 1);
      }
      throw new Error(`no maker for ${key}`);
    };
    const script =
      'Self test (sad): ఈ రోజు మనం ఒక చిన్న కథ చెప్పుకుందాం.\n' +
      'CI test: [happy] ఒక ఊరిలో ఒక రైతు ఉండేవాడు, అతను ప్రతి రోజు పొలానికి వెళ్ళేవాడు. [laughs]\n[pause 1s]\n' +
      'Self test: [excited] ఒక రోజు అతనికి ఒక బంగారు గుడ్డు దొరికింది. Harshith 25 rupayalu.';
    const job = createScriptJob(script, {
      ...opts,
      title: 'Self test dialogue',
      voiceFor: (sp) => (sp === 'Self test' ? `f5:${saved.id}` : sp === 'CI test' ? `fast:${pv.id}` : undefined),
      prepare: (text, language) =>
        prepareText(spokenText(replaceWords(text, [{ from: 'Harshith', to: 'హర్షిత్' }]), language), language),
    });
    log(`dialogue parts=${job.parts.length} voices=${jobVoiceKeys(job).length} pauses=${job.parts.map((p) => p.pauseAfter).join(',')} emotions=${job.parts.map((p) => p.emotion ?? '-').join(',')}`);
    if (job.parts.map((p) => p.emotion ?? '-').join(',') !== 'sad,happy,excited') throw new Error('emotion tags');
    if (jobVoiceKeys(job).length !== 2 || !job.parts.some((p) => p.pauseAfter >= 1)) throw new Error('script parsing');
    let stopNow = false;
    const first = await runJob(job, makerFor, (p) => {
      if (p.partsDone >= 1) stopNow = true;
    }, () => stopNow);
    log(`dialogue stopped=${!first} done=${partsDone(job)}`);
    const finished = await runJob(job, makerFor, () => {}, () => false);
    const out = outputFile(job);
    log(`dialogue finished=${finished} wav=${out.exists ? out.size : 0} bytes audio=${job.audioSeconds.toFixed(1)}s srt=${srtFile(job).exists}`);
    if (!finished || !out.exists || (out.size ?? 0) < 44 + 2 * SAMPLE_RATE || !srtFile(job).exists) throw new Error('dialogue output missing');
    const srt = srtFile(job).textSync();
    if (!srt.includes('-->') || !srt.includes('CI test:')) throw new Error(`bad srt: ${srt.slice(0, 200)}`);

    log(`emotion paths: ${used.join(' ')}`);
    if (!used.includes('f5:sad:recording') || !used.includes('f5:excited:style')) throw new Error('emotion paths');
    // Redo one line with new words, and change a line's voice.
    await redoPart(job, 1, makerFor, 'ఒక ఊరిలో ఒక రైతు ఉండేవాడు.');
    log(`redo line ok, audio=${job.audioSeconds.toFixed(1)}s`);

    // Small file for sharing.
    const m4a = new File(Paths.cache, 'selftest.m4a');
    if (m4a.exists) m4a.delete();
    await SwaramEdge.encodeM4a(out.uri, m4a.uri, 96000);
    log(`m4a ${m4a.size} bytes vs wav ${out.size}`);
    if (!m4a.exists || (m4a.size ?? 0) < 1000 || (m4a.size ?? 0) > (out.size ?? 0) / 2) throw new Error('m4a export');
    // Sound clip in a script, dub from subtitles, background music, noise cleanup, voice sharing.
    const beepFile = new File(Paths.cache, 'selftest-beep.wav');
    beepFile.writeSync(encodeWav(Float32Array.from({ length: SAMPLE_RATE / 2 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 880 * i) / SAMPLE_RATE))));
    await importSound(beepFile.uri, 'beep');
    const fastOnly: MakerFor = async (_key, emotion, mul = 1) => fastMaker(fast, mul, emotion);
    const sfxJob = createScriptJob('CI test: తలుపు తెరువు. [sound: beep] ఎవరు?', {
      ...opts,
      voiceFor: () => `fast:${pv.id}`,
      prepare: (text, language) => prepareText(text, language),
    });
    await runJob(sfxJob, fastOnly, () => {}, () => false);
    log(`sound clip job parts=${sfxJob.parts.length} sound=${sfxJob.parts.some((p) => p.sound === 'beep')} audio=${sfxJob.audioSeconds.toFixed(1)}s`);
    if (!sfxJob.parts.some((p) => p.sound === 'beep') || !outputFile(sfxJob).exists) throw new Error('sound clip');

    const dub = createDubJob(
      '1\n00:00:01,000 --> 00:00:02,500\nCI test: నమస్కారం, ఎలా ఉన్నారు?\n\n2\n00:00:04,000 --> 00:00:05,000\nఈ రోజు వాతావరణం చాలా బాగుంది, మనం బయటికి వెళ్దాం.\n',
      { ...opts, voiceFor: () => `fast:${pv.id}`, prepare: (text, language) => prepareText(text, language) },
    );
    await runJob(dub, fastOnly, () => {}, () => false);
    const dubSrt = srtFile(dub).textSync();
    log(`dub lines=${dub.parts.length} audio=${dub.audioSeconds.toFixed(1)}s srt=${dubSrt.split('\n')[1]} | ${dubSrt.split('\n')[5]}`);
    if (dub.audioSeconds < 4 || !dubSrt.includes('00:00:01') || !dubSrt.includes('00:00:04')) throw new Error('dub timing');

    const musicSrc = new File(Paths.cache, 'selftest-music.wav');
    musicSrc.writeSync(encodeWav(Float32Array.from({ length: SAMPLE_RATE * 3 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE))));
    await addMusic(dub, musicSrc.uri, 'test tone', 0.22);
    log(`music mixed: ${musicFile(dub).exists} final=${finalAudio(dub).uri.endsWith('music.wav')}`);
    if (!musicFile(dub).exists) throw new Error('music mix');

    const noisy = new File(Paths.cache, 'selftest-noisy.f32');
    writeFloats(noisy, testClip(4).map((v) => v + 0.05 * (Math.random() - 0.5)));
    const cleanOut = new File(Paths.cache, 'selftest-clean.f32');
    if (cleanOut.exists) cleanOut.delete();
    const cleanedN = await SwaramEdge.denoise(noisy.uri, cleanOut.uri, 0.6);
    log(`denoise samples=${cleanedN}`);
    if (cleanedN < SAMPLE_RATE * 3) throw new Error('denoise');

    const shared = await exportVoice({ kind: 'f5', voice: withSad });
    const importedName = await importVoice(shared);
    log(`voice shared and imported: ${importedName} (${new File(shared).size} bytes)`);
    const sharedFast = await exportVoice({ kind: 'fast', voice: pv });
    log(`fast voice shared: ${new File(sharedFast).size} bytes`);
    deletePersonal(pv);

    log('OK all checks passed (speak, upload decode, export, fast voice, emotions, two-voice script with pause, stop/resume, subtitles, redo line, m4a, sound clip, dub, music, denoise, voice sharing)');
    await engine.release();
  } catch (e) {
    log(`FAIL ${e instanceof Error ? `${e.message} ${e.stack ?? ''}` : String(e)}`.replace(/\n/g, ' | '));
  }
}
