# Swaram Edge: offline voice cloning on the phone

Phase 1 of running Swaram with **no server**: IndicF5 converted so a phone
can clone a voice and speak Telugu (and 10 more Indian languages) offline.

## How it works

IndicF5 is a 337M-parameter flow-matching model. As shipped it runs its whole
network twice (for guidance) on each of 32 steps, including parts whose
result never changes between steps. For phones it is split into four graphs:

| Graph | Runs | Size | What it does |
|---|---|---|---|
| `mel.onnx` | once per voice | 4 MB | reference clip → log-mel ("the voice file") |
| `context.onnx` | once per sentence | 33 MB | text encoder + reference projection, both guidance branches |
| `flow.int8.onnx` | 8–32 times | 348 MB | the transformer only; runs both guidance branches in one batch, or just one on late steps |
| `vocoder.onnx` | once per sentence | 62 MB | Vocos, with the iSTFT rewritten as matrix products |

- **Exact:** `tests/test_parity.py` checks the split pipeline against the
  original `f5_tts` `CFM.sample` with identical noise, plus the mel and the
  vocoder against torchaudio and Vocos.
- **Smaller:** the step graph is int8 (1.33 GB → 348 MB). About 450 MB to download in total.
- **Clone once:** a voice is a ~6 s log-mel plus its transcript, a few hundred KB, saved on the phone.

## Speed so far

Measured on a 2-core cloud Xeon (`python -m swaram_edge.benchmark`), 11.3 s of
Telugu audio, int8:

| Steps | Compute | Real-time factor |
|---|---|---|
| 8 | 43 s | 3.8× slower than real time |
| 16 | 84 s | 7.4× |
| 32 | 155 s | 13.7× |

fp32 is about 2× slower than int8. A recent phone has 8 faster cores with
int8 dot-product instructions, so expect better than this, but **the only
number that matters is your phone's**: the app's Offline tab prints it after
every generation.

## What Phase 2 changes (needs training)

The per-step cost is the transformer, run as a batch of 2 for guidance.
Without retraining that is the floor. Phase 2 trains a student model to:

1. **Bake guidance in:** one branch instead of two, about 2× faster.
2. **Need fewer steps:** 4 instead of 16–32, via step distillation.
3. **Be smaller:** fewer layers, distilled from IndicF5 on public Indian speech data.

Together that is roughly a 10–30× speed-up over 16-step IndicF5, enough for
real time on mid-range phones. It needs a rented GPU for a few days.

## Run it

```bash
pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu
pip install -r edge/requirements.txt
git clone --depth 1 https://github.com/AI4Bharat/IndicF5.git
export PYTHONPATH=$PWD/edge:$PWD/IndicF5

pytest -q edge/tests                                    # parity tests, ~1 min
python -m swaram_edge.export --hf --out build/edge      # needs HF_TOKEN with IndicF5 access
python -m swaram_edge.benchmark build/edge --ref my.wav --ref-text "..." --out build/bench
```

Or on GitHub: add an `HF_TOKEN` repository secret, then Actions → **Edge model**
→ Run workflow. It runs the tests, exports, benchmarks, renders sample audio,
and publishes the phone files to the `edge-model` release that the app
downloads from.

IndicF5 (AI4Bharat) and Vocos are MIT-licensed. The IndicF5 Hugging Face
page asks users to accept its terms; read them before publishing the
converted files, or run the workflow with **publish** unticked.
