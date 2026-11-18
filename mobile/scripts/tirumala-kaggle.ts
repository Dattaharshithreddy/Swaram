/**
 * Renders the Tirumala guest-house reel (skillvideo repo, reels/tirumala-stay) on Kaggle's free GPU.
 * The notebook pulls the Model Forge buildings and narration from the HF bucket, runs the same
 * render_job.sh the HF Jobs used, and syncs frames back to hf://buckets/HarshithReddy05/tirumala-reel/<tag>
 * every few minutes, so a long overnight run keeps its progress even if the session ends.
 * Settings come from render/tirumala.json: { tag, frames | start+end, spp }.
 */
import { readFileSync } from 'node:fs';
import { pushNotebook, runOutputs, runStatus } from '../src/edge/kaggle.ts';

const auth = { username: process.env.KAGGLE_USERNAME ?? '', token: process.env.KAGGLE_API_TOKEN ?? '' } as never;
const hf = process.env.HF_TOKEN ?? '';
const cfg = JSON.parse(readFileSync('../render/tirumala.json', 'utf8'));
const env: Record<string, string> = { TAG: cfg.tag, SPP: String(cfg.spp ?? 64) };
if (cfg.start) { env.START = String(cfg.start); env.END = String(cfg.end); } else env.FRAMES = String(cfg.frames ?? 'auto');
const slug = 'tirumala-reel-render';
const code = `import os, subprocess, threading, time
os.environ["HF_TOKEN"] = ${JSON.stringify(hf)}
CFG = ${JSON.stringify(env)}
os.environ.update(CFG)
subprocess.run("pip -q install -U huggingface_hub", shell=True)
from huggingface_hub import HfApi
api = HfApi(token=os.environ["HF_TOKEN"]); B = "hf://buckets/HarshithReddy05/tirumala-reel"
os.makedirs("/out/mf", exist_ok=True); os.makedirs("/out/audio", exist_ok=True)
for sub in ("mf", "audio"):
    try: api.sync_bucket(B + "/" + sub, "/out/" + sub, include=["*.glb", "*.wav"], quiet=True)
    except Exception as e: print("sync in", sub, e)
print(os.listdir("/out/mf"), len(os.listdir("/out/audio")))
tag = CFG["TAG"]; os.makedirs("/out/" + tag, exist_ok=True); done = False
def pusher():
    while not done:
        time.sleep(600)
        try: api.sync_bucket("/out/" + tag, B + "/" + tag, quiet=True); print("synced", len(os.listdir("/out/" + tag)), flush=True)
        except Exception as e: print("sync out", e, flush=True)
threading.Thread(target=pusher, daemon=True).start()
subprocess.run("git clone -q --depth 1 -b reels/follow-the-sugar https://github.com/Dattaharshithreddy/skillvideo /w/sv && bash /w/sv/reels/tirumala-stay/hf/render_job.sh 2>&1 | tail -80", shell=True)
done = True
api.sync_bucket("/out/" + tag, B + "/" + tag, quiet=True)
import shutil
os.makedirs("/out/kmeta", exist_ok=True)
for f in ("timing.json", "labels.json", tag + "_build.log"):
    if os.path.exists("/out/" + f): shutil.copy("/out/" + f, "/out/kmeta/" + f)
api.sync_bucket("/out/kmeta", B + "/kaggle_meta", quiet=True)
print("KAGGLE_RENDER_DONE", len(os.listdir("/out/" + tag)))
`;
const nb = { cells: [{ cell_type: 'code', metadata: {}, outputs: [], execution_count: null, source: code }], metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 };
const pushed = await pushNotebook(auth, slug, nb as never, { gpu: true, internet: true, timeoutSeconds: 43200 });
console.log('pushed', slug, (pushed as { url?: string }).url ?? '', JSON.stringify(env));
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 30000));
  const st = await runStatus(auth, slug); console.log('status', st.raw, st.message ?? '');
  if (st.state === 'error' || st.state === 'complete') {
    const o = await runOutputs(auth, slug).catch((e) => ({ files: [], log: String(e) }));
    const log = String(o.log ?? '');
    try { for (const l of JSON.parse(log)) console.log(String(l.data ?? '').trimEnd()); } catch { console.log(log.slice(-3000)); }
    break;
  }
}
