"""Search documents for the legal codes corpus.

The codes collection holds one document per article, which is what the reading
pane and the answer prompt need. It is a poor thing to search: the embedding
model reads only an article's opening, so a row deep in a finance law's table
(the subsidies cut to zero in article 56 of the 2026 law, 15,000 characters in)
never shapes its vector. The search collection is built from it instead:

  * kind="article": every article, under a clean title ("Code pénal, article
    292") and its contexte without the stale chapter carried over by parsing;
  * kind="row": one short document per row of a finance law's tables, label
    first ("SOGATRA (Titre 4. Dépenses de transfert) — LF 2025 : 1,67 milliard ;
    LF 2026 : - ; supprimé (-100 %). Loi de finances 2026 (LF 2026), article 56,
    Tableau des plafonds de dépenses du budget général.");
  * kind="prose": a finance law article's text without its tables.

A finance law article that holds a table gets no "article" search document:
its truncated vector is close to every budget question and pushed the right
article down. Each search document carries the id of its article in the codes
collection (article_id); results are merged back to articles by their best hit.

On the 45-question benchmark (design/papers/kiosque-retrieval), this index
takes recall@5 from 0.79 to 0.90 and the table-row questions from 0.50 to 0.94.
"""
from __future__ import annotations

import re
from collections import defaultdict

CODE_LABEL = {
    "codes_penal": "Code pénal",
    "codes_penal_modifie": "Code pénal (modifié)",
    "codes_minier": "Code minier",
    "codes_hydrocarbures": "Code des hydrocarbures",
    "codes_enfants": "Code de l'enfant",
    "codes_nationalites": "Code de la nationalité",
    "code_travail": "Code du travail",
    "loi_de_finances_2026": "Loi de finances 2026 (LF 2026)",
    "projet_loi_de_finances_2027": "Projet de loi de finances 2027 (PLF 2027)",
}
FINANCE = ("loi_de_finances", "projet_loi")


def article_body(doc: str, meta: dict) -> str:
    """The article text of a codes collection document, which is stored as
    "code - type - numero\\n\\ncontexte\\n\\ntexte" (create_codes_db.py)."""
    title = " - ".join(p for p in [meta.get("code", ""), meta.get("type", ""), meta.get("numero", "")] if p)
    for line in filter(None, [title, meta.get("contexte", "")]):
        if doc.startswith(line):
            doc = doc[len(line):].lstrip("\n")
    return doc


# ── titles and contexte ──────────────────────────────────────────────────────

def clean_title(code: str, numero: str) -> str:
    """'Code pénal, article 292'; 'Loi de finances 2026 (LF 2026), article 221
    nouveau (Code général des impôts)'."""
    law = CODE_LABEL.get(code, code)
    if not numero:
        return f"{law}, préambule"
    num = re.sub(r"^Article", "article", numero.replace("(CGI)", "(Code général des impôts)"))
    return f"{law}, {num}"


def stale_chapters(articles: list[dict]) -> set[tuple[str, str]]:
    """'Chapitre …' segments found under three or more different top-level titles
    of the same code are carry-overs from parsing (penal code: 'Chapitre X : De
    la soustraction …' on nearly every article)."""
    seen = defaultdict(set)
    for a in articles:
        parts = [p.strip() for p in a["contexte"].split("|")]
        for p in parts[1:]:
            if p.lower().startswith("chapitre"):
                seen[(a["code"], p)].add(parts[0])
    return {k for k, v in seen.items() if len(v) >= 3}


def clean_contexte(a: dict, stale: set[tuple[str, str]]) -> str:
    parts = [p.strip() for p in a["contexte"].split("|") if p.strip()]
    return " > ".join(p for p in parts if (a["code"], p) not in stale)


# ── Markdown tables ──────────────────────────────────────────────────────────

_NUM = re.compile(r"^[-+−]?\s?[\d\s.,]+%?$|^-$|^–$")
_MISSION_CODE = re.compile(r"\d{1,3}(\.\d+)*")  # mission and programme codes, "17.640.2"


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().removeprefix("|").removesuffix("|").split("|")]


def _is_num(c: str) -> bool:
    return bool(c) and bool(_NUM.match(c))


def _has_num(cells: list[str]) -> bool:
    return any(_is_num(c) and c not in ("-", "–") for c in cells[1:])


def _is_sep(cells: list[str]) -> bool:
    return any(cells) and all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c)


def _blocks(text: str):
    """('prose', str) and ('table', [lines]) blocks, in order."""
    lines, i, buf = text.split("\n"), 0, []
    while i < len(lines):
        if lines[i].lstrip().startswith("|"):
            if "".join(buf).strip():
                yield "prose", "\n".join(buf).strip()
            buf, j = [], i
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                j += 1
            yield "table", lines[i:j]
            i = j
        else:
            buf.append(lines[i])
            i += 1
    if "".join(buf).strip():
        yield "prose", "\n".join(buf).strip()


def _table_title(prose: str) -> str:
    lines = [l.strip() for l in prose.split("\n") if l.strip()]
    lines = [l for l in lines if not l.lower().startswith("tableau tel qu")]
    for l in reversed(lines):
        m = re.search(r"(Tableau [^:.]{3,120})$", l)
        if m:
            return m.group(1).strip()
        if l.lower().startswith("tableau"):
            return l[:150]
    return (lines[-1][:150] + ("…" if len(lines[-1]) > 150 else "")) if lines else ""


def _parse_table(lines: list[str], prev_header: list[str] | None):
    """Column names and body rows. The header is the rows before the | --- |
    separator plus the rows after it that hold no figure (two-row headers). A
    table that starts with figures continues one cut by a page break, and takes
    the previous table's header."""
    rows = [_cells(l) for l in lines]
    head, body, sep = [], [], False
    for cells in rows:
        if _is_sep(cells):
            sep = True
        elif not body and (not sep or not _has_num(cells)):
            head.append(cells)
        else:
            body.append(cells)
    if head and _has_num(head[0]):
        body, head = head + body, []
    ncol = max((len(c) for c in rows), default=0)
    names = [""] * ncol
    for h in head:
        for j, c in enumerate(h[:ncol]):
            if c:
                names[j] = (names[j] + " " + c).strip()
    if not any(names) and prev_header and len(prev_header) == ncol:
        names = prev_header
    return names, [b for b in body if any(b)]


def _pct(v: str) -> float | None:
    m = re.fullmatch(r"([-+−]?)\s?(\d+(?:[.,]\d+)?)\s?%", v.strip())
    if not m:
        return None
    x = float(m.group(2).replace(",", "."))
    return -x if m.group(1) in ("-", "−") else x


def _in_words(v: str) -> str:
    """'1 673 200 000' -> '1,67 milliard'; '350 000 000' -> '350 millions'."""
    m = re.fullmatch(r"([-−]?)\s?(\d{1,3}(?: \d{3})+)(?:,\d+)?", v.strip())
    if not m:
        return v
    x, sign = int(m.group(2).replace(" ", "")), "-" if m.group(1) else ""
    if x >= 10**9:
        y = f"{x / 1e9:.2f}".rstrip("0").rstrip(".").replace(".", ",")
        return f"{sign}{y} milliard{'s' if x >= 2 * 10**9 else ''}"
    if x >= 10**6:
        y = f"{x / 1e6:.1f}".rstrip("0").rstrip(".").replace(".", ",")
        return f"{sign}{y} millions"
    return v


def _split_row(cells: list[str], names: list[str]):
    code, label, vals = None, None, []
    headerless = not any(names)
    for j, c in enumerate(cells):
        if not c:
            continue
        if label is None and code is None and not vals and _MISSION_CODE.fullmatch(c) \
                and j + 1 < len(cells) and cells[j + 1] and not _is_num(cells[j + 1]):
            code = c
        elif label is None and not _is_num(c) and j <= 2:
            label = c
        elif not (headerless and c in ("0", "-", "–")):
            vals.append((names[j] if j < len(names) else "", c))
    return code, label, vals


def _change(vals) -> str:
    for _, v in vals:
        p = _pct(v) if "%" in v else None
        if p is not None:
            if p <= -100:
                return "supprimé (-100 %)"
            if p < 0:
                return f"en baisse ({p:g} %)"
            return f"en hausse (+{p:g} %)" if p > 0 else "inchangé"
    return ""


def _row_text(source: str, path: list[str], label: str, vals) -> str:
    """The row label leads: with the law and table first, that shared prefix
    outweighed the row's own words in the vector."""
    if len(vals) > 8:  # wide allocation tables: the non-zero cells only
        vals = [(n, v) for n, v in vals if v not in ("0", "-", "–", "0%", "0 %")]
    change = _change(vals)
    kv = [f"{n or 'valeur'} : {_in_words(v)}" for n, v in vals
          if not ("%" in v and _pct(v) is not None) and "cart" not in n]
    ctx = f" ({' > '.join(path)})" if path else ""
    return f"{label}{ctx} — " + " ; ".join(kv) + (f" ; {change}" if change else "") + f". {source}."


def table_rows(text: str, title: str) -> tuple[str, list[tuple[str, str]]]:
    """The article's text without its tables, and (label, document) for each
    table row."""
    prose, out = [], []
    table, prev_header, section = "", None, None
    code_labels: dict[str, str] = {}
    for kind, blk in _blocks(text):
        if kind == "prose":
            prose.append(blk)
            table = _table_title(blk) or table
            continue
        names, body = _parse_table(blk, prev_header)
        if any(names):
            prev_header = names
        for cells in body:
            code, label, vals = _split_row(cells, names)
            label = label or code or ""
            path = []
            if code:  # mission > programme > action, from the dotted codes
                code_labels[code] = label
                segs = code.split(".")
                path = [code_labels[".".join(segs[:i])] for i in range(1, len(segs))
                        if ".".join(segs[:i]) in code_labels]
            elif re.match(r"(?i)^titre\s+\d", label):
                section = label
            elif section:
                path = [section]
            if vals:
                out.append((label, _row_text(f"{title}, {table}" if table else title, path, label, vals)))
    return "\n\n".join(prose), out


# ── build and search ─────────────────────────────────────────────────────────

def search_documents(ids: list[str], docs: list[str], metas: list[dict]):
    """(search ids, texts, metadatas) for the search collection, from the
    contents of the codes collection."""
    articles = [
        {"id": i, "code": m.get("code", ""), "numero": m.get("numero", ""),
         "contexte": m.get("contexte", ""), "texte": article_body(d, m)}
        for i, d, m in zip(ids, docs, metas)
    ]
    stale = stale_chapters(articles)
    out_ids, texts, out_metas = [], [], []

    def add(sid: str, text: str, a: dict, kind: str, label: str = "") -> None:
        out_ids.append(sid)
        texts.append(text)
        out_metas.append({"article_id": a["id"], "code": a["code"], "kind": kind, "label": label})

    for a in articles:
        if not a["texte"]:
            continue
        title = clean_title(a["code"], a["numero"])
        ctx = clean_contexte(a, stale)
        head = title + (f"\n{ctx}" if ctx else "")
        if a["code"].startswith(FINANCE) and "|" in a["texte"]:
            prose, rows = table_rows(a["texte"], title)
            for n, (label, row) in enumerate(rows):
                add(f"{a['id']}|row{n}", row, a, "row", label)
            if prose:
                add(f"{a['id']}|prose", f"{head}\n\n{prose}", a, "prose")
        else:
            add(a["id"], f"{head}\n\n{a['texte']}", a, "article")
    return out_ids, texts, out_metas


def best_per_article(raw: dict, n: int) -> list[tuple[str, float, str, dict]]:
    """(article id, distance, matching text, its metadata) for the first n
    articles of a search collection query, each article ranked by its closest
    document."""
    best: dict[str, tuple[str, float, str, dict]] = {}
    for meta, dist, doc in zip(raw["metadatas"][0], raw["distances"][0], raw["documents"][0]):
        aid = meta["article_id"]
        if aid not in best:
            best[aid] = (aid, dist, doc, meta)
            if len(best) == n:
                break
    return list(best.values())
