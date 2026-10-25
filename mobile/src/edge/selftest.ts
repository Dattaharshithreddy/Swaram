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
import { createJob, outputFile, partsDone, runJob } from './jobs';
import { downloadModel, loadVoiceData, modelDir, modelInstalled, saveAudio, saveVoice } from './store';
import { prepareText } from './telugu';
import { spokenText } from '../translit';

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
    const saved = saveVoice('Self test', 'te', data);
    const reloaded = await loadVoiceData(saved);
    log(`voice saved and reloaded frames=${reloaded.frames}`);

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

    // Long script: stop after the first part, resume, join.
    const script = prepareText(
      'ఈ రోజు మనం ఒక చిన్న కథ చెప్పుకుందాం. ఒక ఊరిలో ఒక రైతు ఉండేవాడు, అతను ప్రతి రోజు పొలానికి వెళ్ళేవాడు. ' +
        'ఒక రోజు అతనికి ఒక బంగారు గుడ్డు దొరికింది, అతను చాలా సంతోషపడ్డాడు. తర్వాత ఏమి జరిగిందో చూద్దాం.',
      'te',
    );
    const job = createJob(engine, saved, reloaded, script, { steps: 2, guidance: 0.5 });
    log(`job parts=${job.parts.length}`);
    if (job.parts.length < 2) throw new Error('script did not split into parts');
    let stopNow = false;
    const first = await runJob(job, engine, reloaded, (p) => {
      if (p.partsDone >= 1) stopNow = true;
    }, () => stopNow);
    log(`job stopped=${!first} done=${partsDone(job)}`);
    const finished = await runJob(job, engine, reloaded, () => {}, () => false);
    const out = outputFile(job);
    log(`job finished=${finished} wav=${out.exists ? out.size : 0} bytes audio=${job.audioSeconds.toFixed(1)}s`);
    if (!finished || !out.exists || (out.size ?? 0) < 44 + 2 * SAMPLE_RATE) throw new Error('job output missing');
    log('OK all checks passed (speak, upload decode, long script resume + join)');
    await engine.release();
  } catch (e) {
    log(`FAIL ${e instanceof Error ? `${e.message} ${e.stack ?? ''}` : String(e)}`.replace(/\n/g, ' | '));
  }
}
