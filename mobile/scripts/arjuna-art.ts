/**
 * Arjuna–Babruvahana reel: Ramayana-film-style pictures on the owner's free Kaggle GPU.
 * Qwen-Image (4-bit, diffusers/qwen-image-nf4) + Qwen-Image-Lightning 8-step LoRA, split over Kaggle's two T4s.
 * Job settings: reel/arjuna/job.json { slug, w, h, steps, neg, items: [{ name, prompt, seeds }] }.
 * Waits for the run, downloads the PNGs to render-out/art (the workflow encrypts them before they leave).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pushNotebook, runOutputs, runStatus } from '../src/edge/kaggle.ts';
const auth = { username: process.env.KAGGLE_USERNAME ?? '', token: process.env.KAGGLE_API_TOKEN ?? '' } as never;
const job = JSON.parse(readFileSync('../reel/arjuna/job.json', 'utf8'));
const slug = job.slug ?? 'arjuna-art';
const code = `import os, subprocess, json, time, traceback
JOB = ${JSON.stringify(job)}
subprocess.run("pip -q install -U diffusers transformers accelerate bitsandbytes peft huggingface_hub", shell=True)
import torch
from diffusers import DiffusionPipeline
from huggingface_hub import list_repo_files, hf_hub_download
print(subprocess.run("nvidia-smi -L", shell=True, capture_output=True, text=True).stdout, flush=True)
os.makedirs("/kaggle/working/art", exist_ok=True)
t0 = time.time()
pipe = DiffusionPipeline.from_pretrained("diffusers/qwen-image-nf4", torch_dtype=torch.bfloat16, device_map="balanced")
lf = [f for f in list_repo_files("lightx2v/Qwen-Image-Lightning") if "8steps" in f and f.endswith(".safetensors") and "Edit" not in f]
lf.sort(); print("lightning files", lf, flush=True)
if lf:
    try:
        pipe.load_lora_weights(hf_hub_download("lightx2v/Qwen-Image-Lightning", lf[-1])); print("lightning on", flush=True); LIGHT = True
    except Exception as e: print("lora failed", e, flush=True); LIGHT = False
else: LIGHT = False
print("loaded in", round(time.time() - t0), "s", flush=True)
steps = 8 if LIGHT else JOB.get("steps", 30)
for it in JOB["items"]:
    for sd in it.get("seeds", [1]):
        out = f"/kaggle/working/art/{it['name']}_s{sd}.png"
        if os.path.exists(out): continue
        try:
            t1 = time.time()
            img = pipe(prompt=JOB.get("style", "") + it["prompt"], negative_prompt=JOB.get("neg", " "), width=JOB.get("w", 928), height=JOB.get("h", 1664),
                       num_inference_steps=steps, true_cfg_scale=1.0 if LIGHT else 4.0, generator=torch.Generator("cpu").manual_seed(sd)).images[0]
            img.save(out); print("made", out, round(time.time() - t1), "s", flush=True)
        except Exception: traceback.print_exc()
print("ART_DONE", sorted(os.listdir("/kaggle/working/art")), flush=True)
`;
const nb = { cells: [{ cell_type: 'code', metadata: {}, outputs: [], execution_count: null, source: code }], metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 };
for (let w = 0; ; w++) {
  try { console.log('push', JSON.stringify(await pushNotebook(auth, slug, nb as never, { gpu: true, internet: true, timeoutSeconds: 14400 }))); break; }
  catch (e) { if (!String(e).includes('GPU session count') || w > 40) throw e; console.log('GPU slots busy, waiting 5 min'); await new Promise((r) => setTimeout(r, 300000)); }
}
let st = { state: '', raw: '' } as { state: string; raw: string; message?: string };
for (let i = 0; i < 900; i++) {
  await new Promise((r) => setTimeout(r, 20000)); st = await runStatus(auth, slug);
  if (i % 6 === 0) console.log(`${i / 3} min`, st.raw, st.message ?? '');
  if (['complete', 'error', 'cancelled'].includes(st.state)) break;
}
const o = await runOutputs(auth, slug);
try { const L = JSON.parse(String(o.log ?? '')).map((l: { data?: string }) => String(l.data ?? '').trimEnd()); console.log(L.filter((l: string) => /made|loaded|lightning|lora|GPU|Error|error|ART_DONE|Traceback|OutOfMemory/.test(l)).slice(-40).join('\n')); } catch { console.log(String(o.log ?? '').slice(-3000)); }
mkdirSync('render-out/art', { recursive: true }); let n = 0;
for (const f of o.files) { if (!f.fileName.endsWith('.png')) continue; const r = await fetch(f.url); if (!r.ok) continue; writeFileSync('render-out/art/' + f.fileName.split('/').pop(), Buffer.from(await r.arrayBuffer())); n++; }
console.log('state', st.state, '| fetched', n, 'pictures');
if (!n) process.exit(1);
