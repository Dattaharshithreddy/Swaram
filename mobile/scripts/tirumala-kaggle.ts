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
if (cfg.logonly) {
  const st = await runStatus(auth, slug); console.log('status', st.raw);
  const o = await runOutputs(auth, slug).catch((e) => ({ files: [], log: String(e) }));
  const lines: string[] = []; try { for (const l of JSON.parse(String(o.log ?? ''))) lines.push(String(l.data ?? '').trimEnd()); } catch { lines.push(String(o.log ?? '')); }
  console.log(lines.join('\n').split('\n').filter((l) => /rror|CYCLES|OPTIX|CUDA|Saved|Traceback|device|RENDER|GPU|frame|Fra:/i.test(l)).slice(-40).join('\n'));
  process.exit(0);
}
const mkCode = (env: Record<string, string>) => `import os, subprocess, threading, time
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
try: api.sync_bucket(B + "/" + tag, "/out/" + tag, quiet=True)   # resume: frames already rendered are skipped
except Exception as e: print("resume sync", e)
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
const mkNb = (env: Record<string, string>) => ({ cells: [{ cell_type: 'code', metadata: {}, outputs: [], execution_count: null, source: mkCode(env) }], metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 });
async function pushWait(sl: string, book: unknown) {
  for (let w = 0; ; w++) {   // Kaggle allows 2 GPU sessions at once; wait for a free slot (up to ~5 h)
    try { return await pushNotebook(auth, sl, book as never, { gpu: true, internet: true, timeoutSeconds: 43200 }); }
    catch (e) { if (!String(e).includes('GPU session count') || w > 60) throw e; console.log('Kaggle GPU slots busy, waiting 5 min'); await new Promise((r) => setTimeout(r, 300000)); }
  }
}
const nParts = Number(cfg.parts ?? 1);
for (let k = 1; k <= nParts; k++) {
  const e2: Record<string, string> = nParts > 1 ? { ...env, START: `part${k}of${nParts}` } : env;
  if (nParts > 1) delete e2.FRAMES;
  const book = mkNb(e2);
  const sl = nParts > 1 ? `${slug}-p${k}` : slug;
  const pushed = await pushWait(sl, book);
  console.log('pushed', sl, (pushed as { url?: string }).url ?? '', JSON.stringify(e2));
}
for (let i = 0; i < (nParts > 1 ? 0 : 8); i++) {
  await new Promise((r) => setTimeout(r, 30000));
  const st = await runStatus(auth, slug); console.log('status', st.raw, st.message ?? '');
  if (st.state === 'error' || st.state === 'complete') {
    const o = await runOutputs(auth, slug).catch((e) => ({ files: [], log: String(e) }));
    const log = String(o.log ?? '');
    try { for (const l of JSON.parse(log)) console.log(String(l.data ?? '').trimEnd()); } catch { console.log(log.slice(-3000)); }
    break;
  }
}
