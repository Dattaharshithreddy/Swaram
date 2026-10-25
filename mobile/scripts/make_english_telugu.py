"""English words → Telugu script, the way Telugu speakers say them in mixed speech
("satellites" → "సాటెలైట్స్"). The voice model reads Telugu script only, so English
words inside a Telugu script are spelled out like this before speaking.

Pronunciations come from the CMU Pronouncing Dictionary (BSD licence), mapped to
Indian-English sounds (t/d are ట/డ, th is థ/ద), and the commonest words are kept.
Writes src/edge/englishTelugu.ts.

    pip install cmudict wordfreq
    python scripts/make_english_telugu.py
"""

from __future__ import annotations

import re
from pathlib import Path

import cmudict
import wordfreq

MIN_ZIPF = 2.5  # about 44k words
COMMON_ZIPF = 3.0  # in all-English-letter text, only these count as English (the rest may be Telugu typed in English)

VIRAMA = "్"
ANUSVARA = "ం"
# vowel: (independent, matra; '' is the inherent a)
VOWELS = {
    "AA": ("ఆ", "ా"), "AE": ("ఆ", "ా"), "AH": ("అ", ""), "AO": ("ఆ", "ా"), "AW": ("ఔ", "ౌ"),
    "AY": ("ఐ", "ై"), "EH": ("ఎ", "ె"), "ER": ("అ", ""), "EY": ("ఏ", "ే"), "IH": ("ఇ", "ి"),
    "IY": ("ఈ", "ీ"), "OW": ("ఓ", "ో"), "OY": ("ఆ", "ా"), "UH": ("ఉ", "ు"), "UW": ("ఊ", "ూ"),
}
CONSONANTS = {
    "B": "బ", "CH": "చ", "D": "డ", "DH": "ద", "F": "ఫ", "G": "గ", "HH": "హ", "JH": "జ", "K": "క",
    "L": "ల", "M": "మ", "N": "న", "NG": "ంగ", "P": "ప", "R": "ర", "S": "స", "SH": "ష", "T": "ట",
    "TH": "థ", "V": "వ", "W": "వ", "Y": "య", "Z": "జ", "ZH": "ష",
}
# Words Telugu speakers say differently from the American dictionary entry.
OVERRIDES = {
    "kilometre": "కిలోమీటర్", "kilometres": "కిలోమీటర్స్", "kilometer": "కిలోమీటర్", "kilometers": "కిలోమీటర్స్",
    "km": "కిలోమీటర్స్", "kms": "కిలోమీటర్స్", "metre": "మీటర్", "metres": "మీటర్స్", "meter": "మీటర్",
    "meters": "మీటర్స్", "centimetre": "సెంటీమీటర్", "centimetres": "సెంటీమీటర్స్", "kg": "కేజీ",
    "kgs": "కేజీలు", "orbit": "ఆర్బిట్", "rocket": "రాకెట్", "rockets": "రాకెట్స్", "satellite": "శాటిలైట్",
    "satellites": "శాటిలైట్స్", "planet": "ప్లానెట్", "planets": "ప్లానెట్స్", "mobile": "మొబైల్",
    "phone": "ఫోన్", "the": "ద", "a": "ఎ", "an": "ఆన్", "of": "ఆఫ్", "and": "అండ్", "is": "ఈజ్",
    "was": "వాజ్", "to": "టు", "so": "సో", "just": "జస్ట్", "very": "వెరీ", "station": "స్టేషన్",
    "science": "సైన్స్", "simple": "సింపుల్", "people": "పీపుల్", "minutes": "మినిట్స్", "minute": "మినిట్",
    "second": "సెకండ్", "seconds": "సెకండ్స్", "hour": "అవర్", "hours": "అవర్స్", "speed": "స్పీడ్",
    "earth": "ఎర్త్", "space": "స్పేస్", "gravity": "గ్రావిటీ", "video": "వీడియో", "channel": "ఛానల్",
    "subscribe": "సబ్స్క్రైబ్", "comment": "కామెంట్", "comments": "కామెంట్స్", "youtube": "యూట్యూబ్",
    "instagram": "ఇన్స్టాగ్రామ్", "whatsapp": "వాట్సాప్", "google": "గూగుల్", "internet": "ఇంటర్నెట్",
    "computer": "కంప్యూటర్", "ok": "ఓకే", "okay": "ఓకే", "bye": "బై", "college": "కాలేజ్", "office": "ఆఫీస్",
    "doctor": "డాక్టర్", "hospital": "హాస్పిటల్", "bus": "బస్", "train": "ట్రైన్", "ticket": "టికెట్",
    "india": "ఇండియా", "nasa": "నాసా", "isro": "ఇస్రో", "ai": "ఏఐ", "mind": "మైండ్", "blowing": "బ్లోయింగ్",
    "twist": "ట్విస్ట్", "round": "రౌండ్", "flat": "ఫ్లాట్", "float": "ఫ్లోట్", "weight": "వెయిట్",
    "next": "నెక్స్ట్", "time": "టైమ్", "almost": "ఆల్మోస్ట్", "super": "సూపర్", "strong": "స్ట్రాంగ్",
    "mountain": "మౌంటెన్", "ball": "బాల్", "curve": "కర్వ్", "per": "పర్", "sunrise": "సన్రైజ్",
    "sunrises": "సన్రైజెస్", "astronaut": "ఆస్ట్రోనాట్", "astronauts": "ఆస్ట్రోనాట్స్",
}


def vowel_hints(word: str, phones: list[str]) -> dict[int, str]:
    """For unstressed 'uh' sounds spelled with a lone i or e (orbit, rocket), use that vowel."""
    w = word[:-1] if word.endswith("e") and len(word) > 3 else word
    groups = re.findall(r"[aeiouy]+", w)
    vowel_idx = [i for i, p in enumerate(phones) if p[:2] in VOWELS]
    if len(groups) != len(vowel_idx):
        return {}
    out = {}
    for g, i in zip(groups, vowel_idx):
        if phones[i] == "AH0" and g in ("i", "e"):
            out[i] = "ి" if g == "i" else "ె"
    return out


def to_telugu(word: str, phones: list[str]) -> str:
    hints = vowel_hints(word, phones)
    out = ""
    bare = False  # last written thing is a consonant waiting for its vowel (virama added later)
    n = len(phones)
    for i, ph in enumerate(phones):
        base = re.sub(r"\d", "", ph)
        nxt = re.sub(r"\d", "", phones[i + 1]) if i + 1 < n else None
        if base in VOWELS:
            indep, matra = VOWELS[base]
            if i in hints:
                matra = hints[i]
                indep = "ఇ" if matra == "ి" else "ఎ"
            if base == "ER" and i == 0:
                indep = "ఎ"
            prev = re.sub(r"\d", "", phones[i - 1]) if i > 0 else None
            if prev in VOWELS and not bare:
                # Two vowels in a row get a glide: actually → ఆక్చువలీ, idea → ఐడియా
                out += "వ" if prev in ("UW", "UH", "OW", "AW") and base not in ("IH", "IY", "EY", "EH") else "య"
                bare = True
            out += matra if bare else indep
            bare = False
            if base == "ER":
                out += "ర"
                bare = True
            elif base == "OY":
                out += "య"
                bare = True
            continue
        c = CONSONANTS[base]
        if base in ("N", "M") and nxt and nxt not in VOWELS and nxt not in ("N", "M", "Y", "R", "L", "W", "HH") and i > 0:
            out = out + ANUSVARA
            bare = False
            continue
        if base == "NG" and nxt in ("K", "G"):
            out += ANUSVARA  # thinking → థింకింగ్
            bare = False
            continue
        if base == "NG":
            out += ANUSVARA + "గ"
        elif base == "Z" and i == n - 1:
            out += "స"  # plural -s
        else:
            out += c
        if nxt is None or nxt not in VOWELS:
            out += VIRAMA
            bare = False
        else:
            bare = True
    if bare:
        out += VIRAMA  # finger → ఫింగర్
    return out


def main() -> None:
    d = cmudict.dict()
    rows: list[tuple[str, str, bool]] = []
    for w, prons in d.items():
        if not w.isalpha() or not w.isascii():
            continue
        z = wordfreq.zipf_frequency(w, "en")
        if z < MIN_ZIPF and w not in OVERRIDES:
            continue
        rows.append((w, OVERRIDES.get(w) or to_telugu(w, prons[0]), z >= COMMON_ZIPF))
    have = {r[0] for r in rows}
    rows += [(w, t, True) for w, t in OVERRIDES.items() if w not in have]
    rows.sort()
    # word<TAB>telugu, with a leading '*' on words common enough to count as English in all-English-letter text
    body = "\n".join(f"{'*' if c else ''}{w}\t{t}" for w, t, c in rows)
    out = Path(__file__).resolve().parent.parent / "src" / "edge" / "englishTelugu.ts"
    out.write_text(
        "// Generated by scripts/make_english_telugu.py from the CMU Pronouncing Dictionary (BSD). Do not edit.\n"
        "// Each line: [*]word<TAB>Telugu spelling; * = common English word.\n"
        f"export const ENGLISH_TELUGU = {body!r};\n".replace("\\t", "\\t"),
        "utf-8",
    )
    print(len(rows), "words,", out.stat().st_size // 1024, "KB")
    for w in ["satellites", "gravity", "orbit", "twist", "simple", "rocket", "kilometres", "astronauts", "float", "weight",
              "sunrises", "mountain", "earth", "station", "strong", "blowing", "next", "curve", "round", "float", "speed",
              "almost", "planet", "computer", "because", "thinking", "business", "important", "question", "different"]:
        print(w, next((t for x, t, _ in rows if x == w), None))


if __name__ == "__main__":
    main()
