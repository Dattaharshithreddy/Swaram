"""Tests for Indian-language text preparation (backend/utils/indic_text.py)."""

import json

import pytest

from backend.utils import indic_text as it


@pytest.mark.parametrize(
    "n, words",
    [
        (0, "సున్నా"),
        (7, "ఏడు"),
        (15, "పదిహేను"),
        (21, "ఇరవై ఒకటి"),
        (40, "నలభై"),
        (100, "వంద"),
        (105, "నూట ఐదు"),
        (200, "రెండు వందలు"),
        (250, "రెండు వందల యాభై"),
        (1000, "వెయ్యి"),
        (1024, "వెయ్యి ఇరవై నాలుగు"),
        (2024, "రెండు వేల ఇరవై నాలుగు"),
        (5000, "ఐదు వేలు"),
        (100000, "లక్ష"),
        (250000, "రెండు లక్షల యాభై వేలు"),
        (10000000, "కోటి"),
        (35000000, "మూడు కోట్ల యాభై లక్షలు"),
    ],
)
def test_telugu_number(n, words):
    assert it.telugu_number(n) == words


def test_expand_numbers_telugu_keeps_suffixes():
    assert it.expand_numbers("2024లో", "te") == "రెండు వేల ఇరవై నాలుగులో"


def test_expand_numbers_telugu_rupees_percent_and_indian_grouping():
    out = it.expand_numbers("₹1,50,000 పై 12% వడ్డీ", "te")
    assert out == "లక్ష యాభై వేలు రూపాయలు పై పన్నెండు శాతం వడ్డీ"


def test_expand_numbers_decimal():
    assert it.expand_numbers("3.5", "te") == "మూడు పాయింట్ ఐదు"


def test_expand_numbers_leaves_latin_tokens_and_other_languages():
    assert it.expand_numbers("COVID19 4K", "te") == "COVID19 4K"
    assert it.expand_numbers("I have 3 apples", "en") == "I have 3 apples"
    assert it.expand_numbers("मेरे पास 3 सेब", "hi") == "मेरे पास 3 सेब"


def test_long_numbers_read_digit_by_digit():
    assert it.expand_numbers("9876543210123", "te").split()[0] == "తొమ్మిది"


def test_glossary_whole_words_and_suffixes():
    glossary = {"te": {"SIP": "ఎస్ఐపీ", "SIP plan": "ఎస్ఐపీ ప్లాన్"}, "*": {"AI": "ఏఐ"}}
    text = it.apply_glossary("SIPలో SIP plan, AI and SIPS", "te", glossary)
    assert text == "ఎస్ఐపీలో ఎస్ఐపీ ప్లాన్, ఏఐ and SIPS"
    # language-specific entries do not leak into other languages
    assert it.apply_glossary("SIP", "hi", glossary) == "SIP"


def test_glossary_roundtrip_and_validation(tmp_path):
    path = tmp_path / "glossary.json"
    saved = it.save_glossary({"te": {" SIP ": "ఎస్ఐపీ", "": "x"}}, path=path)
    assert saved == {"te": {"SIP": "ఎస్ఐపీ"}}
    assert it.load_glossary(path) == saved
    assert json.loads(path.read_text(encoding="utf-8")) == saved
    with pytest.raises(ValueError):
        it.save_glossary({"xx": {}}, path=path)
    with pytest.raises(ValueError):
        it.save_glossary(["not", "a", "dict"], path=path)


def test_prepare_text_applies_glossary_before_numbers():
    glossary = {"te": {"5G": "ఫైవ్ జీ"}}
    assert it.prepare_text("5G 2 నెలల్లో", "te", glossary) == "ఫైవ్ జీ రెండు నెలల్లో"


def test_check_script():
    assert it.check_script("నమస్కారం అండీ", "te") == []
    assert "No Telugu letters" in it.check_script("namaskaram andi", "te")[0]
    assert it.check_script("hello", "en") == []
    mixed = it.check_script("ఈ trick really saves a lot of time every week", "te")
    assert mixed and "%" in mixed[0]
