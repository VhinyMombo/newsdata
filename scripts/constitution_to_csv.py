#!/usr/bin/env python3
"""constitution_to_csv.py — the Constitution of 19 December 2024 (Journal
Officiel n°47 bis) into the code/numero/contexte/texte CSV shape of
scripts/get_codes.py, for create_codes_db.py.

The issue is printed in two columns, and pypdf reads them interleaved (the
preamble ends up inside Article 1). Each page is read column by column with
pdftotext's crop box instead (poppler-utils, local only). Headings wrap onto
a second line ("TITRE PREMIER : DES PRINCIPES ET DES" / "VALEURS DE LA
REPUBLIQUE"), so a heading takes the uppercase lines that follow it. The
promulgation decree after the text is left out.

Usage:
    .venv/bin/python scripts/constitution_to_csv.py data/raw_pdfs/JO-47bis-2024-Constitution.pdf \\
        --out data/constitution.csv
"""
from __future__ import annotations

import argparse
import csv
import re
import subprocess
from pathlib import Path

SOURCE_URL = ("https://gabonmediatime.com/wp-content/uploads/2024/12/"
              "Journal-Officiel_n°47-Bis-du-19-decembre-2024_Constitution.pdf")
CODE = "constitution"
FIRST_PAGE, LAST_PAGE = 3, 28          # page 1 is the contents, page 2 is blank
MASTHEAD = "JOURNAL OFFICIEL DE LA REPUBLIQUE GABONAISE"
WIDTH, HEIGHT, MIDDLE = 595, 842, 298

RE_HEADING = re.compile(r"^(TITRE|CHAPITRE|SECTION)\b")
RE_ARTICLE = re.compile(r"^Article\s+(Premier|\d+(?:\s*(?:er|bis|ter))?)\s*:?\s*(.*)$", re.I)
RE_MASTHEAD = re.compile(r"^(\d{1,2} DECEMBRE 2024 - N°47 Bis|JOURNAL OFF.*|.*FICIEL DE LA REPUBLIQUE GABONAISE|.*QUE GABONAISE|\d{1,2}|_+)$")


def column(pdf: Path, page: int, x: int) -> list[str]:
    out = subprocess.run(["pdftotext", "-f", str(page), "-l", str(page), "-x", str(x), "-y", "0",
                          "-W", str(MIDDLE), "-H", str(HEIGHT), str(pdf), "-"],
                         capture_output=True, text=True, check=True).stdout
    return [" ".join(l.split()) for l in out.split("\n")]


def lines(pdf: Path) -> list[str]:
    out: list[str] = []
    for page in range(FIRST_PAGE, LAST_PAGE + 1):
        for x in (0, MIDDLE):
            for line in column(pdf, page, x):
                if line.startswith("Décret n°0458/PR"):
                    return out
                # the running head is cut at the column edge, at a different letter on each page
                if line and not RE_MASTHEAD.match(line) and not (is_upper(line) and line in MASTHEAD):
                    out.append(line)
    return out


def is_upper(line: str) -> bool:
    letters = [c for c in line if c.isalpha()]
    return bool(letters) and all(c.isupper() for c in letters)


def rows(pdf: Path) -> list[dict]:
    meta = {"code": CODE, "source_url": SOURCE_URL}
    out: list[dict] = []
    titre = chapitre = section = ""
    preamble: list[str] = []
    num, text = "", []
    heading = None            # the level whose heading may still wrap

    def flush():
        if num:
            ctx = " | ".join(filter(None, [titre, chapitre, section]))
            out.append({**meta, "type": "article", "numero": num, "contexte": ctx,
                        "texte": " ".join(text).strip()})

    for line in lines(pdf):
        if heading and is_upper(line) and not RE_HEADING.match(line):
            if heading == "TITRE": titre += " " + line
            elif heading == "CHAPITRE": chapitre += " " + line
            else: section += " " + line
            continue
        heading = None
        m = RE_HEADING.match(line)
        if m:
            flush(); num, text = "", []
            heading = m.group(1)
            if heading == "TITRE": titre, chapitre, section = line, "", ""
            elif heading == "CHAPITRE": chapitre, section = line, ""
            else: section = line
            continue
        m = RE_ARTICLE.match(line)
        if m:
            flush()
            n = m.group(1)
            num = "Article 1" if n.lower() in ("premier", "1er", "1 er") else f"Article {n}"   # as in the other codes
            text = [m.group(2)] if m.group(2) else []
            continue
        if num:
            text.append(line)
        else:
            preamble.append(line)

    flush()
    # pdftotext drops the hyphen of a compound cut at the end of a line
    # ("Vice-" / "Président" -> "VicePrésident")
    rejoin = {"VicePrésident": "Vice-Président", "cidessous": "ci-dessous", "cidessus": "ci-dessus",
              "ciaprès": "ci-après", "luimême": "lui-même", "Union-TravailJustice": "Union-Travail-Justice"}
    for r in out:
        for a, b in rejoin.items():
            r["texte"] = r["texte"].replace(a, b)
        r["texte"] = re.sub(r"\b(dix|vingt|trente|quarante|cinquante|soixante)(un|deux|trois|quatre|cinq|six|sept|huit|neuf)\b",
                            r"\1-\2", r["texte"])
        r["texte"] = r["texte"].split(" Fait à Libreville, le 19 décembre 2024")[0]   # signature after Article 173
    if preamble:
        texte = " ".join(preamble)
        texte = texte[texte.find("Loi référendaire"):]                            # drop the gazette's section headers
        out.insert(0, {**meta, "type": "preambule", "numero": "", "contexte": "", "texte": texte})
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf_path", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    data = rows(args.pdf_path)
    with open(args.out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["code", "source_url", "type", "numero", "contexte", "texte"])
        w.writeheader(); w.writerows(data)
    print(f"{len(data)} ligne(s) -> {args.out}")


if __name__ == "__main__":
    main()
