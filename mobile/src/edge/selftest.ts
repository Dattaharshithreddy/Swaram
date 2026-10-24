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
import { downloadModel, loadVoiceData, modelDir, modelInstalled, saveAudio, saveVoice } from './store';
import { prepareText } from './telugu';

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
    const { wav, timing } = await engine.speak(reloaded, prepareText('ఇది ఒక పరీక్ష. 25 రూపాయలు.', 'te'), {
      steps: 4,
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
      `OK audio=${timing.audioSeconds.toFixed(2)}s wall=${wall.toFixed(1)}s context=${timing.contextSeconds.toFixed(2)}s ` +
        `steps=${timing.stepSeconds.toFixed(1)}s vocoder=${timing.vocoderSeconds.toFixed(2)}s peak=${peak.toFixed(3)} file=${file.uri}`,
    );
    await engine.release();
  } catch (e) {
    log(`FAIL ${e instanceof Error ? `${e.message} ${e.stack ?? ''}` : String(e)}`.replace(/\n/g, ' | '));
  }
}
