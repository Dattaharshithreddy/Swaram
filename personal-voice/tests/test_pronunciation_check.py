"""Practice sentences, the pronunciation score, and the dataset filter.
No models needed: run with `python -m pytest personal-voice/tests`."""

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check_pronunciation as cp
import dataset
import extra_sentences


def test_practice_sentences_use_spoken_number_forms():
    lines = extra_sentences.sentences(300, seed=2)
    assert len(lines) == 300
    assert all(not any(ch.isdigit() for ch in line) for line in lines)
    # Before a noun the joined form: "యాభై వేల రూపాయలు", never "వేలు రూపాయలు".
    for whole in ("వేలు ", "లక్షలు ", "వందలు "):
        assert not any(whole in line for line in lines), whole
    # A count ending in one says ఒక్క before a scale word.
    assert not any("ఒకటి వేల" in line or "ఒకటి లక్షల" in line for line in lines)


def test_joined_form():
    assert extra_sentences.joined("యాభై వేలు") == "యాభై వేల"
    assert extra_sentences.joined("ఆరు వందలు") == "ఆరు వందల"
    assert extra_sentences.joined("రెండు వేల ఇరవై నాలుగు") == "రెండు వేల ఇరవై నాలుగు"


def test_cer_ignores_spacing_punctuation_and_digits():
    expand = cp._expand_numbers()
    assert cp.cer("నమస్కారం, అందరికీ స్వాగతం.", "నమస్కారం అందరికీ స్వాగతం") == 0
    assert cp.cer("నమస్కారం అందరికీ", "నమస్కా రం అందరి‌కీ!") == 0
    # The recogniser may write digits for a spelled-out number.
    assert cp.cer("ధర పన్నెండు రూపాయలు.", "ధర 12 రూపాయలు", expand) == 0
    skipped = cp.cer("ఈ రోజు వాతావరణం చాలా బాగుంది.", "ఈ రోజు బాగుంది")
    assert skipped > 0.3


def _take(path: Path, seconds: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, np.zeros(int(22050 * seconds), dtype=np.float32), 22050)


def test_dataset_leaves_out_mispronounced_takes(tmp_path, monkeypatch, capsys):
    sents = [f"ఇది పరీక్ష వాక్యం సంఖ్య {['ఒకటి', 'రెండు', 'మూడు'][i % 3]}." for i in range(10)]
    (tmp_path / "sentences.json").write_text(json.dumps(sents, ensure_ascii=False), "utf-8")
    for i in range(10):
        _take(tmp_path / "wav" / f"s{i:05d}.wav", 3.0)
    # Two takes clearly wrong, the rest fine.
    asr = {f"s{i:05d}": {"heard": "", "cer": 0.6 if i in (3, 7) else 0.02} for i in range(10)}
    (tmp_path / "asr.json").write_text(json.dumps(asr), "utf-8")

    dataset.main(str(tmp_path))
    rows = (tmp_path / "metadata.csv").read_text("utf-8").strip().splitlines()
    names = {r.split("|")[0] for r in rows}
    assert len(rows) == 8
    assert "s00003.wav" not in names
    assert "s00007.wav" not in names
    assert "Left out 2 takes" in capsys.readouterr().out


def test_filter_never_drops_most_of_the_data():
    # A recogniser that struggles everywhere: keep at least MIN_KEEP of the takes.
    scores = [0.3 + i * 0.01 for i in range(100)]
    limit = dataset.cer_limit(scores)
    kept = sum(s <= limit for s in scores)
    assert kept >= 60
    assert dataset.cer_limit([0.01, 0.02, 0.5]) == dataset.MAX_CER
