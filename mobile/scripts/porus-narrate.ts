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
let parts = JSON.parse(readFileSync('scripts/porus_parts.json', 'utf-8')) as { i: number; para: number; mood: string; text: string; speed: number }[];
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

// 3. run it
const slug = 'swaram-porus-narration';
const t0 = Date.now();
const pushed = await pushNotebook(auth, slug, nb, { gpu: true, internet: true, timeoutSeconds: 5400, kernelSources: [TRAIN], datasetSources: datasets.map((d) => d.split('/').pop()!) });
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
