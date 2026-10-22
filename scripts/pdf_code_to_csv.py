#!/usr/bin/env python3
"""pdf_code_to_csv.py — extract a legal text's articles from a Journal
Officiel PDF into the same code/numero/contexte/texte CSV shape produced by
scripts/get_codes.py's HTML scraper, so it drops straight into
create_codes_db.py alongside the HTML-scraped codes.

Same accumulate-until-next-heading logic as get_codes.py's extract_articles,
adapted from BeautifulSoup DOM elements to plain PDF text lines (pypdf),
plus a Livre level (some laws nest Livre > Titre > Chapitre > Section, one
level deeper than the codes get_codes.py has handled so far) and per-page
running header/footer stripping.

Usage:
    .venv/bin/python scripts/pdf_code_to_csv.py data/raw_pdfs/Loi-de-Finances-2026.pdf \\
        --code loi_de_finances_2026 \\
        --source-url https://directinfosgabon.com/wp-content/uploads/2026/03/Loi-de-Finances-2026.pdf \\
        --out data/loi_de_finances_2026.csv \\
        --start-page 2
"""
from __future__ import annotations

import argparse
import csv
import re
from pathlib import Path

import pypdf

RE_LIVRE          = re.compile(r"^LIVRE\s+", re.IGNORECASE)
# Case-sensitive uppercase only: "à titre de", "au titre du" etc. are common
# lowercase French legal phrasing that would otherwise false-positive as a
# heading when a sentence happens to wrap onto a new line at that word
RE_TITRE          = re.compile(r"^TITRE\s+")
RE_CHAPITRE       = re.compile(r"^Chapitre\s+", re.IGNORECASE)
RE_SECTION        = re.compile(r"^Section\s+|^Sous-section\s+", re.IGNORECASE)
RE_ARTICLE        = re.compile(r"^Article\s+\d+", re.IGNORECASE)
RE_LEADING_PUNCT  = re.compile(r"^[«\"'\-–—\s]+")


def clean(line: str) -> str:
    return " ".join(line.split()).strip()


def _looks_like_heading(text: str) -> bool:
    """Budget-law annexes have table rows like "Titre 4. Autres recettes
    1 073 474 648 271 ..." that start with the same keywords as a real
    Livre/Titre/Chapitre/Section heading. Real headings carry at most one
    ordinal number and stay short; table rows carry many amount columns."""
    return len(re.findall(r"\d+", text)) <= 3 and len(text) <= 150


def extract_rows(pdf_path: Path, code: str, source_url: str, start_page: int = 0) -> list[dict]:
    reader = pypdf.PdfReader(str(pdf_path))
    rows: list[dict] = []
    meta = {"code": code, "source_url": source_url}

    current_livre = current_titre = current_chapitre = current_section = ""
    preamble_lines: list[str] = []
    in_preamble = True
    current_num = ""
    current_text: list[str] = []

    def contexte() -> str:
        return " | ".join(filter(None, [current_livre, current_titre, current_chapitre, current_section]))

    def flush() -> None:
        if current_num:
            rows.append({
                **meta,
                "type": "article",
                "numero": current_num,
                "contexte": contexte(),
                "texte": " ".join(current_text).strip(),
            })

    for page in reader.pages[start_page:]:
        text = page.extract_text() or ""
        for raw_line in text.split("\n"):
            # Running masthead repeats on every page ("JOURNAL OFFICIEL DE LA
            # REPUBLIQUE GABONAISE ... <date> ... <page number>", order flips
            # between odd/even pages for mirrored print margins)
            if "JOURNAL OFFICIEL" in raw_line.upper():
                continue
            line = clean(raw_line)
            if not line:
                continue
            # Amended articles are often reproduced quoted ("« Article 42 : ...")
            test = RE_LEADING_PUNCT.sub("", line)

            if RE_LIVRE.match(test) and _looks_like_heading(test):
                flush()
                current_num, current_text = "", []
                current_livre, current_titre, current_chapitre, current_section = test, "", "", ""
                continue
            if RE_TITRE.match(test) and _looks_like_heading(test):
                flush()
                current_num, current_text = "", []
                current_titre, current_chapitre, current_section = test, "", ""
                continue
            if RE_CHAPITRE.match(test) and _looks_like_heading(test):
                flush()
                current_num, current_text = "", []
                current_chapitre, current_section = test, ""
                continue
            if RE_SECTION.match(test) and _looks_like_heading(test):
                flush()
                current_num, current_text = "", []
                current_section = test
                continue
            if RE_ARTICLE.match(test):
                flush()
                m = re.match(r"(Article\s+\d+(?:\s+bis|\s+ter)?)\s*[:.]?\s*(.*)", test, re.IGNORECASE)
                if m:
                    current_num = m.group(1).strip()
                    rest = m.group(2).strip()
                    current_text = [rest] if rest else []
                else:
                    current_num = test
                    current_text = []
                in_preamble = False
                continue

            if in_preamble:
                preamble_lines.append(line)
            elif current_num:
                current_text.append(line)

    flush()
    if preamble_lines:
        rows.insert(0, {
            **meta, "type": "preambule", "numero": "", "contexte": "",
            "texte": " ".join(preamble_lines),
        })
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf_path", type=Path)
    ap.add_argument("--code", required=True, help="Slug used as the 'code' column (and CODE_LABELS key in api.py)")
    ap.add_argument("--source-url", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--start-page", type=int, default=0, help="0-indexed first page to parse (skip cover/TOC pages)")
    args = ap.parse_args()

    rows = extract_rows(args.pdf_path, args.code, args.source_url, args.start_page)
    fieldnames = ["code", "source_url", "type", "numero", "contexte", "texte"]
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} ligne(s) -> {args.out}")


if __name__ == "__main__":
    main()
