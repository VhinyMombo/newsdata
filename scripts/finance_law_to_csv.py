#!/usr/bin/env python3
"""finance_law_to_csv.py — a Gabonese finance law (or bill) PDF into the codes
CSV shape (code/source_url/type/numero/contexte/texte), following the law's own
plan rather than the codes it amends.

pdf_code_to_csv.py reads a code: every "Article N" is one of its articles and
every LIVRE/TITRE/CHAPITRE heading is its plan. A finance law is different. Its
own articles (1, 2, ... 112) sit in PARTIE > TITRE > CHAPITRE, and a few of them
rewrite articles of other codes in quotes ("« Article 250 nouveau : ... »"), with
that code's LIVRE/TITRE headings in between. Read as a code, those quoted
articles and headings take over the plan. Here:

- a law article is an unquoted "Article N :" whose N follows the previous one;
- a quoted "« Article X ... :" is a provision of the code that the current law
  article amends, kept as its own entry under that law article;
- headings are held until the next article says whose they are: an unquoted
  law article takes them as the law's plan, a quoted one as the amended code's;
- tables (rates, the budget by mission) stay tables, as Markdown rows, instead
  of being flattened into one run-on paragraph;
- page numbers, the running header and the table of contents are dropped.

Usage:
    .venv/bin/python scripts/finance_law_to_csv.py data/raw_pdfs/Projet-Loi-de-Finances-2027.pdf \\
        --code projet_loi_de_finances_2027 --out data/projet_loi_de_finances_2027.csv --first-page 19
"""
from __future__ import annotations

import argparse
import csv
import re
from pathlib import Path

import subprocess

import pdfplumber

LAW_ARTICLE = re.compile(r"^Article\s+(\d+)\s*(er|ère)?\s*:\s*(.*)$", re.S)
CODE_ARTICLE = re.compile(r"^«\s*Article\s+(.+?)\s*:\s*(.*)$", re.S)
LAW_LEVELS = [
    ("partie", re.compile(r"^(PREMIERE|PREMIÈRE|SECONDE|DEUXIEME|DEUXIÈME|TROISIEME|TROISIÈME)\s+PARTIE\b")),
    # The law numbers its titres in Roman numerals; "TITRE 4" belongs to an amended code
    ("titre", re.compile(r"^TITRE\s+[IVXL]+\b")),
    ("chapitre", re.compile(r"^CHAPITRE\s+\w+")),
    ("section", re.compile(r"^[A-H]\s*[-–]\s+\S")),
]
CODE_LEVELS = [
    ("livre", re.compile(r"^LIVRE\s+\w+", re.I)),
    ("titre", re.compile(r"^TITRE\s+\w+", re.I)),
    ("chapitre", re.compile(r"^CHAPITRE\s+\w+", re.I)),
    ("section", re.compile(r"^(Section|Sous-section)\s+\w+", re.I)),
    ("dispositions", re.compile(r"^DISPOSITIONS\s+[A-ZÉÈ ]+$")),
]
CODE_NAMES = [
    (re.compile(r"Code\s+G[ée]n[ée]ral\s+des\s+Imp[ôo]ts", re.I), "Code général des impôts"),
    (re.compile(r"Code\s+des\s+Douanes", re.I), "Code des douanes"),
    (re.compile(r"Code\s+des\s+Hydrocarbures", re.I), "Code des hydrocarbures"),
    (re.compile(r"Code\s+minier", re.I), "Code minier"),
]


def clean(s: str) -> str:
    return " ".join(s.split()).strip()


def heading_kind(text: str, levels) -> str | None:
    """A heading is short and carries few numbers (table rows that start with
    "Titre 4." carry amount columns), and names something: a bare "CHAPITRE 3 :"
    is a fragment of a turned table header, not a heading."""
    if len(text) > 160 or len(re.findall(r"\d+", text)) > 3 or re.fullmatch(r"\S+\s+\S+\s*:?", text):
        return None
    for kind, rx in levels:
        if rx.match(text):
            return kind
    return None


def table_markdown(rows: list[list[str | None]]) -> str:
    """Merged cells split one visual column into several grid columns, and the
    header and the body rows do not always start their text in the same one.
    The columns are the starts most body rows share; every cell joins the
    column it falls in."""
    rows = [[clean(c or "") for c in r] for r in rows]
    rows = [r for r in rows if any(r)]
    if not rows:
        return ""
    patterns: dict[tuple, int] = {}
    for r in rows:
        starts = tuple(j for j, c in enumerate(r) if c)
        patterns[starts] = patterns.get(starts, 0) + 1
    starts = list(max(patterns.items(), key=lambda kv: (kv[1], len(kv[0])))[0])
    if not starts or starts[0] != 0:
        starts = [0] + starts

    def group(j: int) -> int:
        return max(k for k, s in enumerate(starts) if s <= j)

    out_rows = []
    for r in rows:
        cells = [""] * len(starts)
        for j, c in enumerate(r):
            if c:
                g = group(j)
                cells[g] = f"{cells[g]} {c}".strip()
        out_rows.append(cells)
    keep = [k for k in range(len(starts)) if any(r[k] for r in out_rows)]
    out_rows = [[r[k] for k in keep] for r in out_rows]
    out = ["| " + " | ".join(c.replace("|", "/") for c in r) + " |" for r in out_rows]
    out.insert(1, "| " + " | ".join("---" for _ in keep) + " |")
    return "\n".join(out)


def page_blocks(page) -> list[tuple[str, str]]:
    """The page as ("p", paragraph) and ("table", markdown) blocks in reading order."""
    tables = page.find_tables()
    boxes = [t.bbox for t in tables]

    def outside(obj) -> bool:
        x = (obj["x0"] + obj["x1"]) / 2
        y = (obj["top"] + obj["bottom"]) / 2
        return not any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for b in boxes)

    lines = page.filter(outside).extract_text_lines(keep_blank_chars=False)
    items = []
    for t in tables:
        rows = [[clean(c or "") for c in r] for r in t.extract()]
        cells = [c for r in rows for c in r if c]
        # A framed heading or note (one column) is text, not a table
        if all(sum(bool(c) for c in r) <= 1 for r in rows):
            items.extend((t.bbox[1] + k * 0.01, "p", c) for k, c in enumerate(cells))
        else:
            items.append((t.bbox[1], "table", table_markdown(t.extract())))
    # Page number alone at the foot of the page, and the Journal officiel's running
    # header ("2  JOURNAL OFFICIEL DE LA REPUBLIQUE GABONAISE  30 DECEMBRE 2025 - N°96")
    lines = [l for l in lines if not (
        (re.fullmatch(r"\d{1,3}", l["text"].strip()) and (l["top"] > page.height * 0.85 or l["top"] < page.height * 0.08))
        or (l["top"] < page.height * 0.1 and re.search(r"JOURNAL OFFICIEL DE LA R[EÉ]PUBLIQUE|\d{4}\s*-\s*N°\s*\d+", l["text"]))
    )]
    gaps = sorted(b["top"] - a["top"] for a, b in zip(lines, lines[1:]) if b["top"] > a["top"])
    step = gaps[len(gaps) // 2] if gaps else 14
    para: list[str] = []
    para_top = None
    prev = None
    for l in lines:
        text = l["text"].strip()
        # A heading that wraps ("... BUDGETAIRE ET" / "FINANCIER") stays one heading
        heading_wraps = (
            prev is not None and l["top"] - prev["top"] <= step * 1.45 and text.isupper() and len(text) < 90
            and not heading_kind(text, LAW_LEVELS) and not heading_kind(text, CODE_LEVELS)
            and (heading_kind(clean(" ".join(para)), LAW_LEVELS) or heading_kind(clean(" ".join(para)), CODE_LEVELS))
        )
        starts_new = not heading_wraps and (
            prev is None
            or l["top"] - prev["top"] > step * 1.45
            or re.match(r"^(«\s*)?Article\s+\d", text)
            or re.match(r"^[-–•]\s", text)
            or heading_kind(text, LAW_LEVELS) or heading_kind(text, CODE_LEVELS)
            or heading_kind(clean(" ".join(para)), LAW_LEVELS) or heading_kind(clean(" ".join(para)), CODE_LEVELS)
        )
        if starts_new and para:
            items.append((para_top, "p", clean(" ".join(para))))
            para = []
        if not para:
            para_top = l["top"]
        para.append(text)
        prev = l
    if para:
        items.append((para_top, "p", clean(" ".join(para))))
    items.sort(key=lambda t: t[0])
    return [(kind, content) for _, kind, content in items if content]


def landscape_blocks(pdf_path: Path, number: int) -> list[tuple[str, str]]:
    """Landscape pages (the allocation and balance tables) are stored with
    /Rotate 270 and mix upright row labels with turned figures and column
    titles: pdfplumber reads them letter by letter. pdftotext lays them out
    right. Prose lines become paragraphs; the table rows are kept as printed,
    in a fixed-width block. The column titles, printed vertically, do not
    survive: the block says where to find them."""
    text = subprocess.run(["pdftotext", "-layout", "-f", str(number), "-l", str(number), str(pdf_path), "-"],
                          capture_output=True, text=True, check=True).stdout
    blocks: list[tuple[str, str]] = []
    prose: list[str] = []
    rows: list[str] = []

    def flush_prose():
        if prose:
            blocks.append(("p", clean(" ".join(prose))))
            prose.clear()

    def flush_rows():
        # Cells are separated by runs of spaces; the row label comes first.
        # Rows without figures are pieces of the vertical column titles.
        cells = [re.split(r"\s{2,}", r.strip()) for r in rows]
        cells = [c for c in cells if sum(bool(re.fullmatch(r"-?[\d\s,.%]+", x)) for x in c) >= 2]
        rows.clear()
        if not cells:
            return
        width = max(len(c) for c in cells)
        lines = ["| " + " | ".join((c + [""] * (width - len(c)))) + " |" for c in cells]
        # No usable column titles: an empty header row, so no data row poses as one
        lines[:0] = ["| " + " | ".join("" for _ in range(width)) + " |", "| " + " | ".join("---" for _ in range(width)) + " |"]
        blocks.append(("table", f"Tableau tel qu'il est imprimé, sans les intitulés de colonnes, écrits à la verticale page {number - 17} du projet.\n\n" + "\n".join(lines)))

    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped or re.fullmatch(r"\d{1,3}", stripped):
            continue
        is_prose = (
            LAW_ARTICLE.match(stripped) or stripped.startswith("Tableau")
            or (len(stripped) > 40 and not re.search(r"\S\s{3,}\S", stripped) and not re.search(r"\d[\d\s,]{6,}$", stripped))
        ) and not rows
        if is_prose and (heading_kind(stripped, LAW_LEVELS) or heading_kind(stripped, CODE_LEVELS)):
            flush_prose()
            blocks.append(("p", stripped))
        elif is_prose:
            prose.append(stripped)
        else:
            flush_prose()
            rows.append(line)
    flush_prose()
    flush_rows()
    return blocks


def code_amended(text: str) -> str:
    for rx, name in CODE_NAMES:
        if rx.search(text):
            return name
    m = re.search(r"\b(Code\s+(?:de|des|du)\s+[^,;:.()]+)", text)
    if m:
        return clean(m.group(1))
    # Amendments to an earlier law: "la loi n°002/2026 du 17 juillet 2026 portant ..."
    m = re.search(r"loi\s+n\s*°\s*([\d/]+)\s+du\s+(\d{1,2}(?:er)?\s+\w+\s+\d{4})", text)
    return f"Loi n° {m.group(1)} du {m.group(2)}" if m else "texte modifié"


def short(name: str) -> str:
    if name == "Code général des impôts":
        return "CGI"
    m = re.match(r"Loi n° ([\d/]+)", name)
    return f"loi {m.group(1)}" if m else name


def extract(pdf_path: Path, code: str, source_url: str, first_page: int) -> list[dict]:
    law_ctx: dict[str, str] = {}
    code_ctx: dict[str, str] = {}
    pending: list[str] = []
    entries: list[dict] = []
    current: dict | None = None
    law_article: dict | None = None
    last_law = 0
    preamble: list[str] = []

    def apply(levels, ctx, headings):
        order = [k for k, _ in levels]
        for h in headings:
            kind = heading_kind(h, levels)
            if not kind:
                continue
            ctx[kind] = h
            for deeper in order[order.index(kind) + 1:]:
                ctx.pop(deeper, None)

    def law_path() -> list[str]:
        top = " — ".join(x for x in (law_ctx.get("partie"), law_ctx.get("titre")) if x)
        rest = [x for x in (law_ctx.get("chapitre"), law_ctx.get("section")) if x]
        return [top] + rest if top else rest

    with pdfplumber.open(str(pdf_path)) as pdf:
        for number, page in enumerate(pdf.pages[first_page - 1:], start=first_page):
            blocks = landscape_blocks(pdf_path, number) if page.rotation else page_blocks(page)
            for kind, content in blocks:
                if kind == "table":
                    if current is not None:
                        current["texte"].append(content)
                    continue
                m_law = LAW_ARTICLE.match(content)
                m_code = CODE_ARTICLE.match(content)
                if m_law and int(m_law.group(1)) == last_law + 1:
                    apply(LAW_LEVELS, law_ctx, pending)
                    pending = []
                    code_ctx = {}
                    last_law = int(m_law.group(1))
                    law_article = current = {
                        "type": "article", "numero": f"Article {last_law}",
                        "contexte": law_path(), "texte": [m_law.group(3)] if m_law.group(3) else [],
                        "amends": None,
                    }
                    entries.append(current)
                elif m_code and law_article is not None:
                    apply(CODE_LEVELS, code_ctx, pending)
                    pending = []
                    if law_article["amends"] is None:
                        law_article["amends"] = code_amended(" ".join(law_article["texte"]))
                    name = law_article["amends"]
                    code_path = [code_ctx[k] for k, _ in CODE_LEVELS if k in code_ctx]
                    current = {
                        "type": "modification", "numero": f"Article {clean(m_code.group(1))} ({short(name)})",
                        "contexte": law_article["contexte"][:1] + [f"{law_article['numero']} : modifie {'le' if name.startswith('Code') else 'la'} {name[0].lower() + name[1:]}"] + code_path,
                        "texte": [m_code.group(2)] if m_code.group(2) else [],
                    }
                    entries.append(current)
                elif heading_kind(content, LAW_LEVELS) or heading_kind(content, CODE_LEVELS):
                    pending.append(content)
                elif law_article is None:
                    preamble.append(content)
                else:
                    if pending:
                        # Headings not followed by an article (a table title, a sub-heading
                        # inside an article): they belong to the text
                        current["texte"].extend(pending)
                        pending = []
                    current["texte"].append(content)

    rows = []
    if preamble:
        rows.append({"code": code, "source_url": source_url, "type": "preambule", "numero": "",
                     "contexte": "", "texte": "\n\n".join(preamble)})
    for e in entries:
        body = "\n\n".join(e["texte"]).strip()
        if e["type"] == "modification":
            body = re.sub(r"\s*»\s*$", "", body)
        rows.append({"code": code, "source_url": source_url, "type": "article", "numero": e["numero"],
                     "contexte": " | ".join(e["contexte"]), "texte": body})
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("pdf_path", type=Path)
    ap.add_argument("--code", required=True)
    ap.add_argument("--source-url", default="")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--first-page", type=int, default=1, help="1-based page where the law's text starts")
    args = ap.parse_args()
    rows = extract(args.pdf_path, args.code, args.source_url, args.first_page)
    with args.out.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["code", "source_url", "type", "numero", "contexte", "texte"])
        w.writeheader()
        w.writerows(rows)
    print(f"{len(rows)} ligne(s) -> {args.out}")


if __name__ == "__main__":
    main()
