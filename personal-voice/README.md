# Personal fast voice

Trains a small voice model (Piper/VITS, about 60 MB) of one person, so the
Swaram app can speak in that voice about 20 times faster than real time,
offline. The big model (IndicF5) is only used once, to make the training
speech.

Run it for free on Kaggle with `swaram_personal_voice.ipynb` (steps inside).

| Step | Script |
|---|---|
| Pick ~1500 Telugu sentences (everyday lines + Wikipedia) | `make_sentences.py`, `corpus.py` |
| Speak them in the voice with IndicF5 (GPU, one process per GPU) | `generate.py` |
| Training list (drops takes whose length doesn't fit the text) | `dataset.py` |
| Fine-tune Piper's Telugu voice `te_IN-maya-medium` | `train.py` |
| Export ONNX, render samples, pack `swaram-voice-<name>.zip` | `package.py` |

Text goes to the model as phonemes from `telugu_ipa.py`; the app uses the
same rules (`mobile/src/edge/teluguIpa.ts`), both checked against
`tests/golden.json`. The CI workflow `.github/workflows/personal-voice.yml`
runs every step on a CPU with the real models.

`make_notebook.py` builds the notebook; edit it, not the `.ipynb`.
