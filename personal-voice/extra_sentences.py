"""Training lines the Wikipedia/everyday mix lacks: numbers, money, dates,
percentages, and English words used in Telugu.

Numbers are written out in words with the same speller the app and the server
use (backend/utils/indic_text.py, mirrored in mobile/src/edge/telugu.ts), so
the fast voice practises exactly what it will be asked to say. Corpus.clean()
rejects digits, which is why these lines never appeared in training before.
"""

from __future__ import annotations

import importlib.util
import random
from pathlib import Path

_INDIC_TEXT = Path(__file__).resolve().parent.parent / "backend" / "utils" / "indic_text.py"


def _speller():
    """telugu_number() from the backend, loaded by path (no backend imports needed)."""
    spec = importlib.util.spec_from_file_location("swaram_indic_text", _INDIC_TEXT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod.telugu_number


# {n} is replaced by a spelled-out number; each template says which range fits.
# A number directly before a noun takes the joined form ("యాభై వేల రూపాయలు",
# not "యాభై వేలు రూపాయలు"); joined() applies it.
NUMBER_TEMPLATES: list[tuple[str, tuple[int, int]]] = [
    ("ఈ వస్తువు ధర {n} రూపాయలు.", (20, 99_999)),
    ("మా ఊరిలో సుమారు {n} మంది ఉంటారు.", (500, 900_000)),
    ("ఈ ఏడాది {n} శాతం పెరిగింది.", (2, 60)),
    ("మీ ఖాతాలో {n} రూపాయలు జమ అయ్యాయి.", (100, 500_000)),
    ("ఈ వీడియోలో {n} చిట్కాలు చెప్తాను.", (3, 12)),
    ("రైలు {n} నిమిషాలు ఆలస్యంగా వస్తుంది.", (5, 90)),
    ("ఈ పుస్తకంలో {n} పేజీలు ఉన్నాయి.", (80, 900)),
    ("మనం {n} కిలోమీటర్లు ప్రయాణం చేయాలి.", (2, 600)),
    ("నెలకు {n} రూపాయలు పొదుపు చేస్తే చాలు.", (500, 20_000)),
    ("ఈ సినిమా {n} కోట్లు వసూలు చేసింది.", (10, 900)),
    ("ఆయన వయసు {n} సంవత్సరాలు.", (18, 95)),
    ("ఈ ఛానల్‌కి ఇప్పుడు {n} మంది సబ్‌స్క్రైబర్లు ఉన్నారు.", (1_000, 900_000)),
]

YEAR_TEMPLATES = [
    "ఈ సంఘటన {n}లో జరిగింది.",
    "{n} సంవత్సరంలో కొత్త నిబంధనలు వచ్చాయి.",
    "నేను {n}లో ఈ ఉద్యోగంలో చేరాను.",
]

MONTHS = ["జనవరి", "ఫిబ్రవరి", "మార్చి", "ఏప్రిల్", "మే", "జూన్", "జూలై", "ఆగస్టు", "సెప్టెంబర్", "అక్టోబర్", "నవంబర్", "డిసెంబర్"]
DATE_TEMPLATES = [
    "మీటింగ్ {m} {d}న జరుగుతుంది.",
    "దరఖాస్తుకు చివరి తేదీ {m} {d}.",
]

_WHOLE_TO_JOINED = {"వేలు": "వేల", "లక్షలు": "లక్షల", "కోట్లు": "కోట్ల", "వందలు": "వందల"}


def joined(words: str) -> str:
    """The form a number takes before a noun: last scale word joined."""
    head, _, last = words.rpartition(" ")
    if last in _WHOLE_TO_JOINED:
        return f"{head} {_WHOLE_TO_JOINED[last]}".strip()
    return words

# Everyday English words as Telugu speakers say them, in Telugu script.
LOANWORD_LINES = [
    "నా ఫోన్ బ్యాటరీ త్వరగా అయిపోతోంది.",
    "దయచేసి మీ ఈమెయిల్ చెక్ చేయండి.",
    "ఈ యాప్ డౌన్‌లోడ్ చేసుకోవడం చాలా సులభం.",
    "ఇంటర్నెట్ స్పీడ్ ఈ రోజు బాగా లేదు.",
    "మీ పాస్‌వర్డ్ ఎవరికీ చెప్పకండి.",
    "ఆన్‌లైన్ పేమెంట్ చేసిన తర్వాత స్క్రీన్‌షాట్ తీసుకోండి.",
    "ఈ వీడియో నచ్చితే లైక్ చేసి షేర్ చేయండి.",
    "కామెంట్‌లో మీ అభిప్రాయం చెప్పండి.",
    "మ్యూచువల్ ఫండ్‌లో పెట్టుబడి పెట్టే ముందు జాగ్రత్తగా ఆలోచించండి.",
    "బ్యాంక్ లోన్ కోసం ఈ డాక్యుమెంట్లు అవసరం.",
    "కంప్యూటర్ రీస్టార్ట్ చేసి మళ్ళీ ప్రయత్నించండి.",
    "ఈ ఆఫర్ ఈ వారం మాత్రమే ఉంటుంది.",
    "టికెట్ బుకింగ్ ఇప్పుడు మొబైల్‌లోనే చేయొచ్చు.",
    "మీ డెలివరీ రేపు సాయంత్రం వస్తుంది.",
    "హాస్పిటల్‌లో డాక్టర్ అపాయింట్‌మెంట్ తీసుకున్నాను.",
    "క్రికెట్ మ్యాచ్ చూడటానికి స్టేడియంకి వెళ్ళాం.",
    "ఈ రెసిపీకి కొంచెం బట్టర్ కావాలి.",
    "ఆఫీస్‌లో ఈ రోజు చాలా పని ఉంది.",
    "బస్ స్టాప్ దగ్గర నాకోసం వెయిట్ చేయండి.",
    "సోషల్ మీడియాలో ఈ న్యూస్ బాగా వైరల్ అయింది.",
    "కొత్త స్మార్ట్‌ఫోన్ కెమెరా చాలా బాగుంది.",
    "ఈ కోర్సు పూర్తి చేస్తే సర్టిఫికెట్ వస్తుంది.",
    "షాపింగ్ మాల్‌లో చాలా రద్దీగా ఉంది.",
    "ప్రతి రోజు ఉదయం వాకింగ్ చేయడం ఆరోగ్యానికి మంచిది.",
]


def sentences(n: int, seed: int = 0) -> list[str]:
    """Up to ``n`` lines: loanword lines first, then numbers, years and dates."""
    rnd = random.Random(seed)
    spell = _speller()
    out = list(LOANWORD_LINES)
    while len(out) < n:
        kind = rnd.random()
        if kind < 0.6:
            template, (lo, hi) = rnd.choice(NUMBER_TEMPLATES)
            # Round bigger amounts the way people actually say them.
            value = rnd.randint(lo, hi)
            if value > 1000:
                value = round(value, -2 if value < 100_000 else -3)
            # Every template has a noun right after the number.
            line = template.format(n=joined(spell(value)))
        elif kind < 0.8:
            year = rnd.randint(1950, 2030)
            if year % 100 == 0:  # "రెండు వేలలో" etc. need different endings; skip round years
                year += rnd.randint(1, 9)
            line = rnd.choice(YEAR_TEMPLATES).format(n=joined(spell(year)))
        else:
            line = rnd.choice(DATE_TEMPLATES).format(d=spell(rnd.randint(1, 28)), m=rnd.choice(MONTHS))
        if line not in out:
            out.append(line)
    return out[:n]
