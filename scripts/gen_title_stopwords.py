#!/usr/bin/env python3
"""gen_title_stopwords.py — regenerate TITLE_STOPWORDS in frontend/src/App.jsx.

TITLE_STOPWORDS backs the keyword-frequency chart and the trending-topics
time series: words filtered out before counting what's frequent in article
titles. Sourced from spacy.lang.fr.stop_words.STOP_WORDS rather than
hand-picked, plus a small domain layer spaCy has no way to know about
(country/demonym names meaningless in a Gabon-only corpus, a few generic
adjectives that are mostly headline noise here).

spaCy itself is NOT a runtime dependency of this project — this script runs
once (or whenever the domain list changes) to produce a static JS array;
nothing in api.py or App.jsx imports spacy. `pip install spacy` before
running this, it doesn't need to stay installed afterward.

Usage:
    .venv/bin/pip install spacy   # one-off, not a project dependency
    .venv/bin/python scripts/gen_title_stopwords.py
    # then paste the printed array into App.jsx's TITLE_STOPWORDS, or
    # rerun with --write to patch it in place.
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

from spacy.lang.fr.stop_words import STOP_WORDS

ROOT_DIR = Path(__file__).parent.parent
APP_JSX = ROOT_DIR / "frontend" / "src" / "App.jsx"

# Meaningless as a "trending topic" in a Gabon-only corpus (spaCy's list is
# generic French, it has no notion of this corpus's own noise words), plus a
# few generic adjectives that read as headline filler here even though
# they're not stopwords in general prose
DOMAIN_EXTRA = {
    "gabon", "gabonais", "gabonaise",
    "dernier", "dernière", "derniere", "nouvelle",
    "grand", "grande", "petit", "bon",
}

# Elided forms (l', d', qu', j'...) can never appear as standalone tokens:
# titleWords()'s regex in App.jsx strips apostrophes (straight ' or curly ’)
# without inserting a space, so "l'économie" becomes one token
# ("leconomie"), never a separate "l". Keeping them would just be dead
# entries.
_APOSTROPHES = {"'", "’"}


def build_stopwords() -> list[str]:
    merged = (STOP_WORDS | DOMAIN_EXTRA)
    return sorted(w for w in merged if not any(a in w for a in _APOSTROPHES))


def format_js_array(words: list[str], indent: str = "  ", width: int = 110) -> str:
    # Every line but the last must KEEP its trailing comma — lines are
    # joined with a bare "\n", so a stripped comma there would silently
    # produce a missing separator between array elements (invalid JS,
    # concatenating two string literals instead of listing two entries)
    lines: list[str] = []
    line = indent
    for w in words:
        item = f"'{w}',"
        if len(line) + len(item) > width:
            lines.append(line)
            line = indent
        line += item
    lines.append(line.rstrip(","))
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true", help="Patch TITLE_STOPWORDS in App.jsx in place instead of printing")
    args = ap.parse_args()

    words = build_stopwords()
    js_array = format_js_array(words)
    print(f"// {len(words)} words")

    if not args.write:
        print(js_array)
        return

    src = APP_JSX.read_text(encoding="utf-8")
    pattern = re.compile(r"const TITLE_STOPWORDS = new Set\(\[.*?\]\);", re.DOTALL)
    if not pattern.search(src):
        raise SystemExit("Could not find TITLE_STOPWORDS in App.jsx — paste the array in manually.")
    replacement = f"const TITLE_STOPWORDS = new Set([\n{js_array}\n]);"
    APP_JSX.write_text(pattern.sub(replacement, src, count=1), encoding="utf-8")
    print(f"Patched {APP_JSX}")


if __name__ == "__main__":
    main()
