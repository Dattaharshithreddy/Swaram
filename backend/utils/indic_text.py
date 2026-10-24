"""
Text preparation for Indian-language speech.

Applied to every generation (see ``utils.chunked_tts.generate_chunked``):

1. **Glossary** - user-defined replacements, e.g. "SIP" -> "ఎస్ఐపీ", so
   brand names and English terms are pronounced the same way every time.
   Stored in ``<data dir>/glossary.json`` and editable through the
   ``/indic/glossary`` API.
2. **Numbers** - digits are spelled out in the target language. F5-based
   models (IndicF5) read digit strings unreliably. Telugu has a hand-written
   converter that follows spoken usage (వెయ్యి, రెండు వేల, నూట ఐదు, లక్ష,
   కోటి). Bengali uses ``num2words``. Other languages keep their digits.
3. **Symbols** - "₹500" and "40%" become the spoken form in Telugu.

It also offers a script check: Telugu text typed in English letters
("namaskaram") is a common mistake that makes Indian TTS models fail.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import unicodedata
from collections.abc import Callable
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Languages and scripts
# ---------------------------------------------------------------------------

LANGUAGE_NAMES = {
    "en": "English",
    "hi": "Hindi",
    "te": "Telugu",
    "ta": "Tamil",
    "kn": "Kannada",
    "ml": "Malayalam",
    "mr": "Marathi",
    "bn": "Bengali",
    "gu": "Gujarati",
    "or": "Odia",
    "pa": "Punjabi",
    "as": "Assamese",
}

# Unicode block of the script each language is normally written in.
SCRIPT_RANGES: dict[str, tuple[int, int, str]] = {
    "hi": (0x0900, 0x097F, "Devanagari"),
    "mr": (0x0900, 0x097F, "Devanagari"),
    "bn": (0x0980, 0x09FF, "Bengali"),
    "as": (0x0980, 0x09FF, "Bengali-Assamese"),
    "pa": (0x0A00, 0x0A7F, "Gurmukhi"),
    "gu": (0x0A80, 0x0AFF, "Gujarati"),
    "or": (0x0B00, 0x0B7F, "Odia"),
    "ta": (0x0B80, 0x0BFF, "Tamil"),
    "te": (0x0C00, 0x0C7F, "Telugu"),
    "kn": (0x0C80, 0x0CFF, "Kannada"),
    "ml": (0x0D00, 0x0D7F, "Malayalam"),
}


def script_share(text: str, language: str) -> float | None:
    """Share of letters in ``text`` that belong to the language's script.

    Returns None for languages without a script range (English) or when the
    text has no letters at all.
    """
    rng = SCRIPT_RANGES.get(language)
    if rng is None:
        return None
    lo, hi, _name = rng
    letters = [c for c in text if unicodedata.category(c)[0] in ("L", "M")]
    if not letters:
        return None
    native = sum(1 for c in letters if lo <= ord(c) <= hi)
    return native / len(letters)


def check_script(text: str, language: str) -> list[str]:
    """Return human-readable warnings about the text's script."""
    warnings: list[str] = []
    share = script_share(text, language)
    if share is None:
        return warnings
    script = SCRIPT_RANGES[language][2]
    name = LANGUAGE_NAMES.get(language, language)
    if share == 0:
        warnings.append(
            f"No {script} letters found. {name} voices need text written in {script} script, not in English letters."
        )
    elif share < 0.6:
        warnings.append(
            f"Only {round(share * 100)}% of the letters are in {script} script. Mixed "
            f"English words are fine, but long English passages may sound wrong in a "
            f"{name} voice."
        )
    return warnings


# ---------------------------------------------------------------------------
# Telugu numbers
# ---------------------------------------------------------------------------

_TE_UNITS = ["సున్నా", "ఒకటి", "రెండు", "మూడు", "నాలుగు", "ఐదు", "ఆరు", "ఏడు", "ఎనిమిది", "తొమ్మిది"]
_TE_TEENS = ["పది", "పదకొండు", "పన్నెండు", "పదమూడు", "పద్నాలుగు", "పదిహేను", "పదహారు", "పదిహేడు", "పద్దెనిమిది", "పందొమ్మిది"]
_TE_TENS = ["", "", "ఇరవై", "ముప్పై", "నలభై", "యాభై", "అరవై", "డెబ్బై", "ఎనభై", "తొంభై"]


def _te_below_100(n: int) -> str:
    if n < 10:
        return _TE_UNITS[n]
    if n < 20:
        return _TE_TEENS[n - 10]
    tens, unit = divmod(n, 10)
    return _TE_TENS[tens] + ("" if unit == 0 else " " + _TE_UNITS[unit])


def _te_below_1000(n: int) -> str:
    if n < 100:
        return _te_below_100(n)
    hundreds, rest = divmod(n, 100)
    if hundreds == 1:
        head_whole, head_joined = "వంద", "నూట"
    else:
        count = _te_below_100(hundreds)
        head_whole, head_joined = f"{count} వందలు", f"{count} వందల"
    return head_whole if rest == 0 else f"{head_joined} {_te_below_100(rest)}"


# Each scale: its value, then the word for one of it (alone and before more
# words) and the plural forms (alone and before more words).
_TE_SCALES = [
    (10_000_000, "కోటి", "కోటి", "కోట్లు", "కోట్ల"),
    (100_000, "లక్ష", "లక్ష", "లక్షలు", "లక్షల"),
    (1_000, "వెయ్యి", "వెయ్యి", "వేలు", "వేల"),
]


def telugu_number(n: int) -> str:
    """Spell out a non-negative integer the way it is spoken in Telugu.

    Uses the Indian scale (వెయ్యి, లక్ష, కోటి): 2024 -> "రెండు వేల ఇరవై
    నాలుగు", 105 -> "నూట ఐదు", 250000 -> "రెండు లక్షల యాభై వేలు".
    """
    if n < 0:
        return "మైనస్ " + telugu_number(-n)
    if n < 1000:
        return _te_below_1000(n)
    for value, one_whole, one_joined, many_whole, many_joined in _TE_SCALES:
        if n >= value:
            count, rest = divmod(n, value)
            if count == 1:
                head = one_whole if rest == 0 else one_joined
            else:
                words = telugu_number(count)
                head = f"{words} {many_whole if rest == 0 else many_joined}"
            return head if rest == 0 else f"{head} {telugu_number(rest)}"
    return _te_below_1000(n)  # unreachable


def _telugu_decimal(int_part: int, frac_digits: str) -> str:
    frac = " ".join(_TE_UNITS[int(d)] for d in frac_digits)
    return f"{telugu_number(int_part)} పాయింట్ {frac}"


# ---------------------------------------------------------------------------
# Number expansion
# ---------------------------------------------------------------------------

# 1,23,456 / 123,456 / 2024 / 3.75 - commas only between digit groups.
# Indian-script suffixes may follow directly ("2024లో"), so only Latin
# letters and digits block a match; "COVID19" and "4K" stay as written.
_NUMBER_RE = re.compile(r"(?<![A-Za-z0-9.])(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?(?![A-Za-z0-9])")
_RUPEE_RE = re.compile(r"(?:₹|Rs\.?|INR)\s?(\d[\d,]*(?:\.\d+)?)", re.IGNORECASE)
_PERCENT_RE = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s?%")

MAX_SPELLED_NUMBER = 10**12  # beyond this, phone numbers etc. are read digit by digit


def _spell_telugu(int_text: str, frac_text: str | None) -> str:
    value = int(int_text.replace(",", ""))
    if value >= MAX_SPELLED_NUMBER:
        return " ".join(_TE_UNITS[int(d)] for d in int_text if d.isdigit())
    if frac_text:
        return _telugu_decimal(value, frac_text)
    return telugu_number(value)


def _num2words_speller(lang: str) -> Callable[[str, str | None], str] | None:
    try:
        from num2words import num2words
    except ImportError:
        return None

    def spell(int_text: str, frac_text: str | None) -> str:
        value_text = int_text.replace(",", "") + (f".{frac_text}" if frac_text else "")
        value = float(value_text) if frac_text else int(value_text)
        if value >= MAX_SPELLED_NUMBER:
            return int_text
        return num2words(value, lang=lang)

    return spell


def _speller_for(language: str) -> Callable[[str, str | None], str] | None:
    if language == "te":
        return _spell_telugu
    if language == "bn":
        return _num2words_speller("bn")
    return None


def expand_numbers(text: str, language: str) -> str:
    """Spell out numbers (and ₹ / % in Telugu) for languages that support it."""
    speller = _speller_for(language)
    if speller is None:
        return text

    if language == "te":
        text = _RUPEE_RE.sub(lambda m: f"{m.group(1)} రూపాయలు", text)
        text = _PERCENT_RE.sub(lambda m: f"{m.group(1)} శాతం", text)

    def repl(m: re.Match) -> str:
        try:
            return speller(m.group(1), m.group(2))
        except Exception:  # never fail a generation over a number
            return m.group(0)

    return _NUMBER_RE.sub(repl, text)


# ---------------------------------------------------------------------------
# Glossary
# ---------------------------------------------------------------------------

GLOSSARY_FILE = "glossary.json"
ALL_LANGUAGES_KEY = "*"
_glossary_lock = threading.Lock()


def _glossary_path() -> Path:
    from .. import config

    return Path(config.get_data_dir()) / GLOSSARY_FILE


def load_glossary(path: Path | None = None) -> dict[str, dict[str, str]]:
    """Read the glossary: ``{language code or "*": {term: replacement}}``."""
    path = path or _glossary_path()
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        logger.warning("Ignoring unreadable glossary %s: %s", path, exc)
        return {}
    return validate_glossary(data)


def validate_glossary(data) -> dict[str, dict[str, str]]:
    """Coerce/validate glossary data, raising ValueError on bad shapes."""
    if not isinstance(data, dict):
        raise ValueError("Glossary must be an object keyed by language code")
    clean: dict[str, dict[str, str]] = {}
    for lang, entries in data.items():
        if lang != ALL_LANGUAGES_KEY and lang not in LANGUAGE_NAMES:
            raise ValueError(f"Unknown language in glossary: {lang}")
        if not isinstance(entries, dict):
            raise ValueError(f"Glossary entries for {lang} must be an object")
        clean[lang] = {}
        for term, replacement in entries.items():
            term = str(term).strip()
            if not term:
                continue
            clean[lang][term] = str(replacement)
    return clean


def save_glossary(data: dict, path: Path | None = None) -> dict[str, dict[str, str]]:
    clean = validate_glossary(data)
    path = path or _glossary_path()
    with _glossary_lock:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        tmp = Path(str(path) + ".tmp")
        tmp.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    return clean


def apply_glossary(text: str, language: str, glossary: dict[str, dict[str, str]]) -> str:
    """Replace whole-word glossary terms. Longest terms are applied first."""
    entries: dict[str, str] = {}
    entries.update(glossary.get(ALL_LANGUAGES_KEY, {}))
    entries.update(glossary.get(language, {}))
    for term in sorted(entries, key=len, reverse=True):
        # Latin terms need Latin word boundaries, but an Indian-script
        # suffix may follow directly ("SIPలో"), so it does not block a match.
        before = r"(?<![A-Za-z0-9])" if term[0].isascii() and term[0].isalnum() else ""
        after = r"(?![A-Za-z0-9])" if term[-1].isascii() and term[-1].isalnum() else ""
        pattern = before + re.escape(term) + after
        text = re.sub(pattern, lambda _m, r=entries[term]: r, text)
    return text


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def prepare_text(
    text: str,
    language: str,
    glossary: dict[str, dict[str, str]] | None = None,
) -> str:
    """Glossary first (so terms can contain digits), then numbers."""
    if not text:
        return text
    if glossary is None:
        glossary = load_glossary()
    text = apply_glossary(text, language, glossary)
    text = expand_numbers(text, language)
    return text
