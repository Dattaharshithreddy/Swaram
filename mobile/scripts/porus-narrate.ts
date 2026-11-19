/**
 * Puru reel narration on a Kaggle GPU with the owner's trained studio voice (no server needed).
 * One part per sentence so the voice never drifts over a long take; speed per mood.
 * Reference voice and weights come from the finished studio-voice training run.
 * Output: render-out/porus-narr.zip (one wav per sentence + parts.json), encrypted by the workflow.
 *   node --experimental-strip-types scripts/porus-narrate.ts
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { bytesToBase64, pushNotebook, runOutputs, runStatus } from '../src/edge/kaggle.ts';

const auth = { username: process.env.KAGGLE_USERNAME ?? '', token: process.env.KAGGLE_API_TOKEN ?? '' };
const hf = process.env.HF_TOKEN ?? '';
const TRAIN = process.env.STUDIO_RUN ?? 'swaram-studio-voice-retrain1';
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean).map(Number);   // re-render chosen sentences only
if (!auth.username || !auth.token) throw new Error('Kaggle secrets missing');
mkdirSync('render-out', { recursive: true });

// 1. the trained studio voice: weights from the training run, reference = one of the owner's own recordings
const tr = await runOutputs(auth, TRAIN);
const ckpt = tr.files.map((f) => f.fileName.split('/').pop()!).find((n) => n.endsWith('.safetensors'))!;
const tok = auth.token.trim();
const authHeader = /^[0-9a-f]{32}$/i.test(tok) ? `Basic ${btoa(`${auth.username.trim()}:${tok}`)}` : `Bearer ${tok}`;
const k = await (await fetch('https://api.kaggle.com/v1/kernels.KernelsApiService/GetKernel', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authHeader },
  body: JSON.stringify({ userName: auth.username.trim(), kernelSlug: TRAIN }) })).json() as Record<string, any>;
const meta = k.metadata ?? k;
let datasets: string[] = (meta.datasetDataSources ?? meta.dataset_data_sources ?? []) as string[];
if (!datasets.length) {
  const l = await (await fetch('https://api.kaggle.com/v1/datasets.DatasetApiService/ListDatasets', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authHeader },
    body: JSON.stringify({ user: auth.username.trim(), search: 'swaram-pro', page: 1 }) })).json() as Record<string, any>;
  datasets = ((l.datasets ?? []) as { ref?: string }[]).map((d) => d.ref ?? '').filter((r) => r && !r.includes('check'));
}
console.log('weights', ckpt, '| recordings', datasets.join(', ') || 'NONE');
if (!datasets.length) throw new Error('recordings dataset not found');
const refWav = new Uint8Array(0); const refText = '';
// 2. the script
let parts: any[] = JSON.parse(readFileSync('scripts/porus_parts.json', 'utf-8')) as { i: number; para: number; mood: string; text: string; speed: number }[];
if (ONLY.length) parts = parts.filter((p) => ONLY.includes(p.i));
const emoSrc = readFileSync('src/edge/emotions.ts', 'utf-8');
const READS: Record<string, string> = {};
for (const m of emoSrc.matchAll(/(\w+): \{ label: '[^']*', telugu: '[^']*', how: '[^']*', read: '([^']*)'/g)) READS[m[1]] = m[2];
const MOODS: Record<string, string> = { sad: 'sad', anger: 'angry', fear: 'fearful', surprise: 'surprised', happy: 'happy', disgust: 'disgusted', 'story, slow': 'calm' };
const job = {
  steps: Number(process.env.STEPS ?? 40), cfg: 2.0,
  voices: { datta: { text: refText, wav_base64: bytesToBase64(refWav), ckpt_name: ckpt } },   // reference filled in on Kaggle
  parts: parts.map((p) => ({ i: p.i, voice: 'datta', text: p.text, speed: p.speed })),
};
const nb = JSON.parse(readFileSync('../cloud/swaram_render.ipynb', 'utf-8'));
nb.cells.splice(1, 0, { cell_type: 'code', metadata: {}, outputs: [], execution_count: null,
  source: `import os, glob, base64, soundfile as _sf, librosa as _lr\nos.environ["HF_TOKEN"] = ${JSON.stringify(hf)}\nAPP_RENDER = ${JSON.stringify(job)}\n` +
`_m = glob.glob('/kaggle/input/**/metadata.csv', recursive=True)\nassert _m, glob.glob('/kaggle/input/**', recursive=True)[:40]\n` +
`_rows = [l.split('|', 1) for l in open(_m[0], encoding='utf-8').read().splitlines() if '|' in l]\n` +
`_c = []\n` +
`for _n, _t in _rows:\n    _f = glob.glob(os.path.dirname(_m[0]) + '/**/' + _n, recursive=True)\n    if not _f: continue\n` +
`    _d = _lr.get_duration(path=_f[0])\n    if 2.0 <= _d <= 12 and _t.strip()[-1:] in '.?!।': _c.append((_d, _f[0], _t.strip()))\n` +
`assert _c, 'no usable recording'\n_c.sort(key=lambda x: -x[0])\n_pick, _tot = [], 0.0\n` +
`for _x in _c:\n    if _tot + _x[0] > 11.5: continue\n    _pick.append(_x); _tot += _x[0]\n    if _tot >= 7.5: break\n` +
`import numpy as _np\n_gap = _np.zeros(int(0.35 * 24000), dtype=_np.float32)\n_parts = []\n` +
`for _x in _pick:\n    _w, _ = _lr.load(_x[1], sr=24000, mono=True); _w, _ = _lr.effects.trim(_w, top_db=35); _parts += [_w, _gap]\n` +
`_sf.write('/kaggle/working/ref.wav', _np.concatenate(_parts[:-1]), 24000)\n` +
`print('reference from', len(_pick), 'recordings,', round(_tot, 1), 's')\n` +
`APP_RENDER['voices']['datta']['wav_base64'] = base64.b64encode(open('/kaggle/working/ref.wav', 'rb').read()).decode()\n` +
`APP_RENDER['voices']['datta']['text'] = ' '.join(_x[2] for _x in _pick)` + '\n' +
// mood clips: the owner's own emotion recordings (same idea as the server's mood clips) give each line its tone
`_READS = ${JSON.stringify(READS)}\n_MOODS = ${JSON.stringify(MOODS)}\n_LINE_MOOD = ${JSON.stringify(Object.fromEntries(parts.map((p) => [p.i, p.mood])))}\n` +
`import json as _js, re as _re\n_norm = lambda t: _re.sub(r'[^\\u0C00-\\u0C7F]', '', t)\n_emo = {}\n` +
`for _e in glob.glob('/kaggle/input/**/emotions.json', recursive=True):\n    try: _emo.update({str(k): v for k, v in _js.load(open(_e)).items() if v})\n    except Exception as _x: print('emotions.json unreadable', _x)\n` +
`_byemo = {}\n` +
`for _k, (_n, _t) in enumerate(_rows):\n    _f = glob.glob(os.path.dirname(_m[0]) + '/**/' + _n, recursive=True)\n    if not _f: continue\n` +
`    _e = next((e for e, r in _READS.items() if _norm(r)[:14] and _norm(_t).startswith(_norm(r)[:14])), None) or _emo.get(str(_k)) or _emo.get(os.path.splitext(_n)[0])\n` +
`    if not _e: continue\n    _d = _lr.get_duration(path=_f[0])\n    if 1.5 <= _d <= 14: _byemo.setdefault(_e, []).append((_d, _f[0], _t.strip()))\n` +
`print('mood recordings found:', {k: len(v) for k, v in _byemo.items()})\n` +
`for _e, _l in _byemo.items():\n    _l.sort(key=lambda x: -x[0]); _sel, _tt = [], 0.0\n    for _x in _l:\n        if _tt + _x[0] > 11: continue\n        _sel.append(_x); _tt += _x[0]\n        if _tt >= 5: break\n` +
`    _ws = []\n    for _x in _sel:\n        _w, _ = _lr.load(_x[1], sr=24000, mono=True); _w, _ = _lr.effects.trim(_w, top_db=35); _ws += [_w, _gap]\n` +
`    _sf.write(f'/kaggle/working/ref_{_e}.wav', _np.concatenate(_ws[:-1]), 24000)\n` +
`    APP_RENDER['voices']['datta_' + _e] = dict(APP_RENDER['voices']['datta'], text=' '.join(_x[2] for _x in _sel), wav_base64=base64.b64encode(open(f'/kaggle/working/ref_{_e}.wav', 'rb').read()).decode())\n` +
`for _p in APP_RENDER['parts']:\n    _e = _MOODS.get(_LINE_MOOD.get(str(_p['i'])) or _LINE_MOOD.get(_p['i'], ''))\n    if _e and ('datta_' + _e) in APP_RENDER['voices']: _p['voice'] = 'datta_' + _e; _p['speed'] = 1.0\n` +
`print('lines with a mood clip:', sum(_p['voice'] != 'datta' for _p in APP_RENDER['parts']), 'of', len(APP_RENDER['parts']))` });

// fix mode: redo chosen lines with the owner's own finished narration (encrypted on porus-src) as reference
const FIX = process.env.FIX === '1';
if (FIX) {
  const spec = {"8": [[16.061, 18.761], [19.201, 21.361]]} as Record<string, number[][]>;
  const refs = {"8": [6, 7]} as Record<string, number[]>;
  // spellings to try for a line the voice keeps saying wrong; a Whisper check afterwards shows which one came out right
  const VARIANTS: Record<string, [string, number][]> = { '8': [['కానీ ఆయుధాలతో!', 0.85], ['కానీ ఆయూధాలతో!', 1.0], ['కానీ ఆయూధాలతో!', 0.88], ['సరిహద్దులోనే కలుద్దాం… కానీ ఆయుధాలతో!', 1.0], ['సరిహద్దులోనే కలుద్దాం… కానీ ఆయూధాలతో!', 1.0], ['పురు జవాబు ఒక్కటే… సరిహద్దులోనే కలుద్దాం… కానీ ఆయుధాలతో!', 1.0]] };
  const all = JSON.parse(readFileSync('scripts/porus_parts.json', 'utf-8')) as { i: number; text: string }[];
  const fixParts = Object.keys(spec).flatMap((k) => (VARIANTS[k] ?? [[all[Number(k)].text, 1.0], [all[Number(k)].text, 1.0]]).flatMap(([text, speed], v) => [0, 1].map((t) => ({ i: (v * 2 + t) * 1000 + Number(k), voice: `r${k}`, text, speed }))));
  const voices: Record<string, unknown> = {};
  for (const k of Object.keys(spec)) voices[`r${k}`] = { text: refs[k].map((r) => all[r].text).join(' '), wav_base64: '', ckpt_name: ckpt };
  const fjob = { steps: Number(process.env.STEPS ?? 40), cfg: 2.0, voices, parts: fixParts };
  nb.cells[1] = { cell_type: 'code', metadata: {}, outputs: [], execution_count: null,
    source: `import os, json, base64, subprocess, urllib.request, numpy as _np, soundfile as _sf, librosa as _lr\nfrom huggingface_hub import hf_hub_download\nos.environ["HF_TOKEN"] = ${JSON.stringify(hf)}\nAPP_RENDER = ${JSON.stringify(fjob)}\n_SPEC = ${JSON.stringify(spec)}\n` +
`_key = open(hf_hub_download('HarshithReddy05/porus-private', 'key.txt', repo_type='dataset', token=os.environ['HF_TOKEN'])).read().strip()\n` +
`urllib.request.urlretrieve('https://raw.githubusercontent.com/Dattaharshithreddy/Swaram/porus-src/up.opus.enc', '/tmp/a.enc')\n` +
`subprocess.run(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-in', '/tmp/a.enc', '-out', '/tmp/a.opus', '-pass', 'pass:' + _key], check=True)\n` +
`subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', '/tmp/a.opus', '-ar', '24000', '-ac', '1', '/tmp/a.wav'], check=True)\n` +
`_w, _ = _lr.load('/tmp/a.wav', sr=24000, mono=True)\n_gap = _np.zeros(int(0.3 * 24000), dtype=_np.float32)\n` +
`for _k, _segs in _SPEC.items():\n    _ws = []\n    for _a, _b in _segs: _ws += [_w[int(max(0, _a - 0.05) * 24000):int((_b + 0.08) * 24000)], _gap]\n` +
`    _sf.write('/tmp/r.wav', _np.concatenate(_ws[:-1]), 24000)\n    APP_RENDER['voices']['r' + _k]['wav_base64'] = base64.b64encode(open('/tmp/r.wav', 'rb').read()).decode()\n` +
`for _f in ('/tmp/a.enc', '/tmp/a.opus', '/tmp/a.wav', '/tmp/r.wav'): os.remove(_f)\nprint('fix refs ready', list(_SPEC))` };
  nb.cells.push({ cell_type: 'code', metadata: {}, outputs: [], execution_count: null, source:
`import glob, json, torch\nfrom transformers import pipeline\n_p = pipeline('automatic-speech-recognition', model='openai/whisper-large-v3', torch_dtype=torch.float16, device=0)\n` +
`for _f in sorted(glob.glob('/tmp/render/out/parts/*.wav')):\n    _t = _p(_f, generate_kwargs={'language': 'telugu', 'task': 'transcribe'})['text']\n    print('###CHK ' + _f.split('/')[-1] + ' ' + _t.strip())` });
  parts = fixParts.map((p) => ({ ...p, para: 0, mood: 'fix' }));
}

// mood mode: the whole narration again, each line from a mood clip cut out of the owner's server narration
// (that narration was made with the server's mood clips, so its lines carry each mood's delivery)
if (process.env.MOODS === '1') {
  const AL = {"0": [0.4, 1.82], "1": [1.82, 6.18], "2": [6.72, 9.4], "3": [10.0, 11.681], "4": [12.181, 13.441], "5": [13.861, 15.241], "6": [16.061, 18.761], "7": [19.201, 21.361], "8": [21.681, 22.541], "9": [23.321, 26.901], "10": [27.321, 28.361], "11": [28.681, 32.181], "12": [32.561, 33.762], "13": [34.582, 36.722], "14": [37.082, 38.962], "15": [39.442, 42.522], "16": [43.062, 45.762], "17": [46.142, 47.762], "18": [48.602, 50.542], "19": [50.902, 54.322], "20": [54.642, 56.963], "21": [57.383, 59.583], "22": [59.923, 62.303], "23": [63.163, 65.223], "24": [65.763, 69.323], "25": [69.763, 73.443], "26": [73.803, 75.943], "27": [76.763, 79.464], "28": [79.744, 81.284], "29": [81.624, 83.004], "30": [83.444, 85.224], "31": [86.024, 87.404], "32": [87.824, 89.244], "33": [89.764, 93.504], "34": [93.984, 95.584], "35": [96.004, 99.164], "36": [99.684, 102.905], "37": [103.765, 106.405], "38": [106.905, 108.805], "39": [109.305, 111.825], "40": [112.285, 115.925], "41": [116.785, 118.625], "42": [118.925, 121.965], "43": [122.446, 126.506], "44": [126.866, 129.286], "45": [130.066, 131.366], "46": [131.706, 135.886], "47": [136.626, 137.546], "48": [137.886, 138.626], "49": [138.906, 140.046], "50": [140.526, 143.286], "51": [143.806, 144.927]} as Record<string, number[]>;
  const MOODREFS = {"story": [1, 40], "talk": [35, 43], "anger": [7, 32, 33], "sad": [9, 46], "disgust": [10, 11, 12], "surprise": [15, 25], "fear": [23, 24], "happy": [41, 42, 51]} as Record<string, number[]>;
  const all = JSON.parse(readFileSync('scripts/porus_parts.json', 'utf-8')) as { i: number; para: number; mood: string; text: string }[];
  const spec: Record<string, number[][]> = {}; const voices: Record<string, unknown> = {};
  for (const [m, ids] of Object.entries(MOODREFS)) {
    spec[m] = ids.map((i) => AL[String(i)]);
    voices[`m_${m}`] = { text: ids.map((i) => all[i].text).join(' '), wav_base64: '', ckpt_name: ckpt };
  }
  const mparts = all.map((p) => { const m = p.mood.split(',')[0].trim(); return { i: p.i, voice: `m_${MOODREFS[m] ? m : 'story'}`, text: p.text, speed: p.mood.includes('slow') ? 0.92 : 1.0 }; });
  const mjob = { steps: Number(process.env.STEPS ?? 40), cfg: 2.0, voices, parts: mparts };
  nb.cells[1] = { cell_type: 'code', metadata: {}, outputs: [], execution_count: null,
    source: `import os, json, base64, subprocess, urllib.request, numpy as _np, soundfile as _sf, librosa as _lr\nfrom huggingface_hub import hf_hub_download\nos.environ["HF_TOKEN"] = ${JSON.stringify(hf)}\nAPP_RENDER = ${JSON.stringify(mjob)}\n_SPEC = ${JSON.stringify(spec)}\n` +
`_key = open(hf_hub_download('HarshithReddy05/porus-private', 'key.txt', repo_type='dataset', token=os.environ['HF_TOKEN'])).read().strip()\n` +
`urllib.request.urlretrieve('https://raw.githubusercontent.com/Dattaharshithreddy/Swaram/porus-src/up.opus.enc', '/tmp/a.enc')\n` +
`subprocess.run(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-in', '/tmp/a.enc', '-out', '/tmp/a.opus', '-pass', 'pass:' + _key], check=True)\n` +
`subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', '/tmp/a.opus', '-ar', '24000', '-ac', '1', '/tmp/a.wav'], check=True)\n` +
`_w, _ = _lr.load('/tmp/a.wav', sr=24000, mono=True)\n_gap = _np.zeros(int(0.3 * 24000), dtype=_np.float32)\n` +
`for _k, _segs in _SPEC.items():\n    _ws = []\n    for _a, _b in _segs: _ws += [_w[int(max(0, _a - 0.05) * 24000):int((_b + 0.08) * 24000)], _gap]\n` +
`    _sf.write('/tmp/r.wav', _np.concatenate(_ws[:-1]), 24000)\n    APP_RENDER['voices']['m_' + _k]['wav_base64'] = base64.b64encode(open('/tmp/r.wav', 'rb').read()).decode()\n` +
`for _f in ('/tmp/a.enc', '/tmp/a.opus', '/tmp/a.wav', '/tmp/r.wav'): os.remove(_f)\nprint('mood clips ready', list(_SPEC))` };
  nb.cells.push({ cell_type: 'code', metadata: {}, outputs: [], execution_count: null, source:
`import glob, torch\nfrom transformers import pipeline\n_p = pipeline('automatic-speech-recognition', model='openai/whisper-large-v3', torch_dtype=torch.float16, device=0)\n` +
`for _f in sorted(glob.glob('/tmp/render/out/parts/*.wav')):\n    _t = _p(_f, generate_kwargs={'language': 'telugu', 'task': 'transcribe'})['text']\n    print('###CHK ' + _f.split('/')[-1] + ' ' + _t.strip())` });
  parts = mparts.map((p) => ({ ...p, para: all[p.i].para, mood: all[p.i].mood }));
}

// Whisper check of every sentence (as in the narration guide's checklist)
if (process.env.CHECK === '1' && process.env.FIX !== '1' && process.env.MOODS !== '1') nb.cells.push({ cell_type: 'code', metadata: {}, outputs: [], execution_count: null, source:
`import glob, torch\nfrom transformers import pipeline\n_p = pipeline('automatic-speech-recognition', model='openai/whisper-large-v3', torch_dtype=torch.float16, device=0)\n` +
`for _f in sorted(glob.glob('/tmp/render/out/parts/*.wav')):\n    _t = _p(_f, generate_kwargs={'language': 'telugu', 'task': 'transcribe'})['text']\n    print('###CHK ' + _f.split('/')[-1] + ' ' + _t.strip())` });

// 3. run it
const slug = 'swaram-porus-narration';
const t0 = Date.now();
let pushed: { url?: string } = {};
for (let w = 0; ; w++) {   // Kaggle allows 2 GPU sessions at once; wait for a free slot (up to ~4 h)
  try { pushed = await pushNotebook(auth, slug, nb, { gpu: true, internet: true, timeoutSeconds: 5400, kernelSources: [TRAIN], datasetSources: datasets.map((d) => d.split('/').pop()!) }); break; }
  catch (e) { if (!String(e).includes('GPU session count') || w > 48) throw e; console.log('Kaggle GPU slots busy, waiting 5 min'); await new Promise((r) => setTimeout(r, 300000)); }
}
console.log('pushed', pushed.url ?? slug, parts.length, 'sentences');
let state = '';
for (let i = 0; i < 260; i++) {
  await new Promise((r) => setTimeout(r, 20000));
  const s = await runStatus(auth, slug); state = s.state;
  if (i % 3 === 0) console.log(`${Math.round((Date.now() - t0) / 60000)} min`, s.state, s.message ?? '');
  if (['complete', 'error', 'cancelled'].includes(s.state)) break;
}
const out = await runOutputs(auth, slug);
if (state !== 'complete') {
  const all = (out.log ?? '').split('\n').map((l) => { try { return (JSON.parse(l.replace(/^,/, '')) as { data: string }).data.trimEnd(); } catch { return ''; } }).filter(Boolean);
  console.log('--- kaggle log (filtered) ---');
  const cut = all.findIndex((l) => l.includes('Exception encountered'));
  const body = (cut > 0 ? all.slice(0, cut) : all).filter((l) => !/NbConvert|cells\[i\]|Escape underscores|it\/s\]|%\|/.test(l));
  console.log(body.slice(-60).join('\n'));
  throw new Error(`narration run ended as ${state}`);
}
for (const l of (out.log ?? '').split('\\n')) { const m = l.match(/###CHK[^"]*/); if (m) console.log(m[0]); }
if ((out.log ?? '').includes('Trained model not found')) console.log('WARNING: studio weights not found, used the normal model');
const zip = out.files.find((f) => f.fileName.endsWith('swaram-render.zip'));
if (!zip) throw new Error(`no swaram-render.zip in ${out.files.map((f) => f.fileName).join(', ')}`);
writeFileSync('render-out/r.zip', new Uint8Array(await (await fetch(zip.url)).arrayBuffer()));
execSync('cd render-out && mkdir -p narr && unzip -o -q r.zip -d narr && rm r.zip');
writeFileSync('render-out/narr/parts.json', JSON.stringify(parts, null, 0));
const wavs = readdirSync('render-out/narr').filter((n) => n.endsWith('.wav'));
console.log(wavs.length, 'sentence files');
execSync('cd render-out && zip -q -r porus-narr.zip narr');
console.log(`narration done in ${Math.round((Date.now() - t0) / 60000)} min`);
