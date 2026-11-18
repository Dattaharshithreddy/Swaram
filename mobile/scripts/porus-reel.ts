/**
 * Full-quality Puru reel on Kaggle's free GPUs (T4): 12 Cycles shots, Telugu motion design, the owner's narration.
 * The narration is AES-encrypted on the porus-src branch; its key is in the owner's private Hugging Face
 * dataset, read on Kaggle with HF_TOKEN. The finished reel is downloaded by the workflow and encrypted there.
 *   FETCH_ONLY=1 skips the push and just collects the last run's output.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { pushNotebook, runOutputs, runStatus } from '../src/edge/kaggle.ts';

const auth = { username: process.env.KAGGLE_USERNAME ?? '', token: process.env.KAGGLE_API_TOKEN ?? '' };
const hf = process.env.HF_TOKEN ?? '';
if (!auth.username || !auth.token || !hf) throw new Error('secrets missing');
mkdirSync('render-out', { recursive: true });
const slug = 'swaram-porus-reel';
const src = `import os, subprocess, glob
def sh(c): print('$', c[:120], flush=True); subprocess.run(c, shell=True, check=True)
os.makedirs('/tmp/w', exist_ok=True); os.chdir('/tmp/w')
sh('git clone -q --depth 1 -b reels/follow-the-sugar https://github.com/Dattaharshithreddy/skillvideo.git sv')
sh('wget -q https://download.blender.org/release/Blender4.2/blender-4.2.3-linux-x64.tar.xz -O b.tar.xz && tar xf b.tar.xz && mv blender-4.2.3-linux-x64 blender && rm b.tar.xz')
sh('apt-get -qq update > /dev/null')
for _pk in 'libxi6 libxkbcommon0 libsm6 libxrender1 libxxf86vm1 libgl1 ffmpeg libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2'.split() + ['libasound2|libasound2t64']:
    _ok = any(subprocess.run(f'apt-get -qq install -y {_c} > /dev/null 2>&1', shell=True).returncode == 0 for _c in _pk.split('|'))
    print('apt', _pk, 'ok' if _ok else 'MISSING', flush=True)
sh('curl -fsSL https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz | tar -xJ -C /opt')
os.environ['PATH'] = '/opt/node-v20.18.0-linux-x64/bin:' + os.environ['PATH']
sh('cd sv/reels/porus/mg && npm install --no-audit --no-fund --loglevel=error && npx remotion browser ensure > /dev/null')
from huggingface_hub import hf_hub_download
key = hf_hub_download('HarshithReddy05/porus-private', 'key.txt', repo_type='dataset', token=${JSON.stringify(hf)})
sh('mkdir -p sv/reels/porus/narr && curl -fsSL https://raw.githubusercontent.com/Dattaharshithreddy/Swaram/porus-src/narr.flac.enc -o /tmp/n.enc')
sh(f'openssl enc -d -aes-256-cbc -pbkdf2 -in /tmp/n.enc -out /tmp/n.flac -pass file:{key} && ffmpeg -v error -y -i /tmp/n.flac sv/reels/porus/narr/narration.wav && rm /tmp/n.enc /tmp/n.flac')
ngpu = len(subprocess.run('nvidia-smi -L', shell=True, capture_output=True, text=True).stdout.strip().splitlines()); print('GPUs', ngpu)
os.environ.update(BL='/tmp/w/blender/blender', NGPU=str(max(1, ngpu)), SPP='40', CONC='4', NARR='narr/narration.wav', SENTS='hf/sentences.json')
sh("bash sv/reels/porus/render_all.sh 2>&1 | grep -vE 'INFO|^\\\\s*$' | grep -E '==|shot|REEL_DONE|rror|Traceback' | tail -80")
sh('cp sv/reels/porus/mg/out/puru_reel.mp4 /kaggle/working/puru_reel.mp4 && ls -la /kaggle/working')
`;
const nb = { metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } }, nbformat: 4, nbformat_minor: 4,
  cells: [{ cell_type: 'code', metadata: {}, outputs: [], execution_count: null, source: src }] };
const t0 = Date.now();
if (process.env.FETCH_ONLY !== '1') {
  await pushNotebook(auth, slug, nb, { gpu: true, internet: true, timeoutSeconds: 43200 });
  console.log('pushed', slug);
}
let state = '';
for (let i = 0; i < 1000; i++) {                       // the workflow's own time limit ends this if Kaggle takes longer
  const s = await runStatus(auth, slug); state = s.state;
  if (i % 15 === 0) console.log(`${Math.round((Date.now() - t0) / 60000)} min`, s.state);
  if (['complete', 'error', 'cancelled'].includes(s.state)) break;
  await new Promise((r) => setTimeout(r, 20000));
}
const out = await runOutputs(auth, slug);
const lines = (out.log ?? '').split('\n').map((l) => { try { return (JSON.parse(l.replace(/^,/, '')) as { data: string }).data; } catch { return ''; } }).join('').split('\n');
console.log(lines.filter((l) => /==|shot |REEL_DONE|rror|Traceback|GPUs|^\$/.test(l)).slice(-60).join('\n'));
const f = out.files.find((x) => x.fileName.endsWith('puru_reel.mp4'));
if (state !== 'complete' || !f) throw new Error(`reel run ended as ${state}`);
writeFileSync('render-out/puru_reel.mp4', new Uint8Array(await (await fetch(f.url)).arrayBuffer()));
console.log(`reel done in ${Math.round((Date.now() - t0) / 60000)} min`);
