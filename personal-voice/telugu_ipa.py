"""Telugu script -> phonemes (IPA symbols Piper voices already know).

Follows espeak-ng's Telugu output closely, so fine-tuning from Piper's
Telugu voice (te_IN-maya-medium) starts from familiar symbols, but has no
espeak dependency: the app runs the same rules on the phone
(mobile/src/edge/teluguIpa.ts, checked against tests/golden.json).
"""

from __future__ import annotations

import re
import unicodedata

CONSONANTS = {
    "క": "k", "ఖ": "kʰ", "గ": "ɡ", "ఘ": "ɡʰ", "ఙ": "ŋ",
    "చ": "c", "ఛ": "cʰ", "జ": "ɟ", "ఝ": "ɟʰ", "ఞ": "ɲ",
    "ట": "ʈ", "ఠ": "ʈʰ", "డ": "ɖ", "ఢ": "ɖʰ", "ణ": "ɳ",
    "త": "t", "థ": "tʰ", "ద": "d", "ధ": "dʰ", "న": "n",
    "ప": "p", "ఫ": "pʰ", "బ": "b", "భ": "bʰ", "మ": "m",
    "య": "j", "ర": "r", "ఱ": "r", "ల": "l", "వ": "ʋ",
    "శ": "ɕ", "ష": "ʂ", "స": "s", "హ": "h", "ళ": "ɭ",
}
VOWELS = {  # independent letter, vowel sign
    "అ": ("a", None), "ఆ": ("aː", "ా"), "ఇ": ("i", "ి"), "ఈ": ("iː", "ీ"),
    "ఉ": ("u", "ు"), "ఊ": ("uː", "ూ"), "ఋ": ("ru", "ృ"), "ౠ": ("ruː", "ౄ"),
    "ఎ": ("e", "ె"), "ఏ": ("eː", "ే"), "ఐ": ("aɪ", "ై"),
    "ఒ": ("o", "ొ"), "ఓ": ("oː", "ో"), "ఔ": ("aʊ", "ౌ"),
}
SIGNS = {sign: ipa for ipa, sign in VOWELS.values() if sign}
INDEPENDENT = {letter: ipa for letter, (ipa, _) in VOWELS.items()}
VIRAMA = "్"
ANUSVARA = "ం"
VISARGA = "ః"
PUNCT = {",": ",", ".": ".", "?": "?", "!": "!", ";": ";", ":": ":", "।": ".", "॥": ".", "-": " "}
STRESS = "ˈ"


def _word(word: str) -> str:
    out: list[str] = []
    i = 0
    stressed = False

    def vowel(ipa: str):
        nonlocal stressed
        if not stressed:
            out.append(STRESS)
            stressed = True
        out.append(ipa)

    while i < len(word):
        ch = word[i]
        if word.startswith("జ్ఞ", i):  # jña is said "gna"
            out.append("ɡn")
            i += 3
            nxt = word[i] if i < len(word) else ""
            if nxt in SIGNS:
                vowel(SIGNS[nxt])
                i += 1
            elif nxt == VIRAMA:
                i += 1
            else:
                vowel("a")
            continue
        if ch in CONSONANTS:
            out.append(CONSONANTS[ch])
            nxt = word[i + 1] if i + 1 < len(word) else ""
            if nxt == VIRAMA:
                i += 2
            elif nxt in SIGNS:
                if nxt in ("ృ", "ౄ"):
                    out.append("r")
                    vowel(SIGNS[nxt][1:])
                else:
                    vowel(SIGNS[nxt])
                i += 2
            else:
                vowel("a")  # inherent vowel, also at the end of a word
                i += 1
        elif ch in INDEPENDENT:
            if ch in ("ఋ", "ౠ"):
                out.append("r")
                vowel(INDEPENDENT[ch][1:])
            else:
                vowel(INDEPENDENT[ch])
            i += 1
        elif ch == ANUSVARA:
            out.append("n")
            i += 1
        elif ch == VISARGA:
            out.append("h")
            i += 1
        else:
            i += 1  # signs without a consonant, ZWJ/ZWNJ, other scripts: dropped
    return "".join(out)


def phonemize(text: str) -> str:
    """Telugu text (numbers already spelled out) -> one phoneme string."""
    text = unicodedata.normalize("NFC", text)
    out: list[str] = []
    for token in re.findall(r"[ఀ-౿‌‍]+|[,.?!;:।॥-]|\s+", text):
        if token.isspace():
            if out and out[-1] != " ":
                out.append(" ")
        elif token in PUNCT:
            while out and out[-1] == " ":
                out.pop()
            p = PUNCT[token]
            out.append(p)
            if p != " ":
                out.append(" ")
        else:
            out.append(_word(token))
    return "".join(out).strip()


if __name__ == "__main__":
    import sys

    for line in sys.argv[1:] or ["నమస్కారం, నా పేరు దత్త."]:
        print(phonemize(line))
