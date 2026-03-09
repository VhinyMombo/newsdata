#!/usr/bin/env python3
"""
Découverte et extraction des articles du Journal Officiel gabonais.

1. Interroge l'API DataTables  POST /ajax/newspaper.twg  pour récupérer
   toutes les entrées (1 914 à ce jour).
2. Visite chaque entrée ; ignore celles sans résumé
   ("Il n'y a pas de résumé pour ce Journal Officiel").
3. Extrait les articles exactement comme get_codes.py.
4. Sauvegarde un CSV par numéro de JO + un CSV combiné dans data/.

Usage (depuis la racine du projet) :
    python scripts/discover_jo.py              # tout scraper
    python scripts/discover_jo.py --limit 20   # tester sur 20 entrées
    python scripts/discover_jo.py --start 100  # reprendre à partir du rang 100
    python scripts/discover_jo.py --workers 4  # paralléliser (4 threads)
"""

from __future__ import annotations

import argparse
import csv
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ROOT_DIR   = Path(__file__).parent.parent
DATA_DIR   = ROOT_DIR / "JOdata"
BASE_URL   = "https://journal-officiel.ga"
API_URL    = f"{BASE_URL}/ajax/newspaper.twg"
BATCH_SIZE = 100          # records per API call
NO_SUMMARY = "n'y a pas"  # sentinel text meaning "no content"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "X-Requested-With": "XMLHttpRequest",
}

FIELDNAMES = ["code", "source_url", "type", "numero", "contexte", "texte"]

# ---------------------------------------------------------------------------
# Regex helpers (same as get_codes.py)
# ---------------------------------------------------------------------------

RE_ARTICLE  = re.compile(r"^Article\s+\d+", re.IGNORECASE)
RE_CHAPITRE = re.compile(r"^Chapitre\s+", re.IGNORECASE)
RE_SECTION  = re.compile(r"^Section\s+|^Sous-section\s+", re.IGNORECASE)
RE_TITRE    = re.compile(r"^Titre\s+|^TITRE\s+", re.IGNORECASE)


def _clean(text: str) -> str:
    return " ".join(text.split()).strip()


def _tag_text(tag) -> str:
    return _clean(tag.get_text(separator=" "))


# ---------------------------------------------------------------------------
# Step 1 — Enumerate all JO entries via the DataTables API
# ---------------------------------------------------------------------------

def fetch_all_entries() -> list[dict]:
    """Return list of {id, title, period, url} for every JO entry."""
    entries: list[dict] = []
    start = 0
    total: int | None = None
    session = requests.Session()
    session.headers.update(HEADERS)

    while True:
        payload = {
            "draw": str(start // BATCH_SIZE + 1),
            "start": str(start),
            "length": str(BATCH_SIZE),
            "type": "journal",
        }
        resp = session.post(API_URL, data=payload, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        if total is None:
            total = data["recordsTotal"]
            print(f"Total entrées : {total}")

        batch = data.get("data", [])
        if not batch:
            break
        entries.extend(batch)
        print(f"  {len(entries)}/{total} entrées récupérées…", end="\r")

        start += BATCH_SIZE
        if start >= total:
            break
        time.sleep(0.3)

    print()
    return entries


# ---------------------------------------------------------------------------
# Step 2 — Parse one JO page → list of article dicts
# ---------------------------------------------------------------------------

def _has_article_structure(html: str) -> bool:
    """
    Return True only when the page contains real Article-N headings
    (i.e. 'Article N' at the START of a DOM element, not just referenced
    inside a sentence like 'l\u2019article 2 du décret...').
    Requires at least 2 matches to filter out single incidental mentions.
    """
    soup = BeautifulSoup(html, "lxml")
    candidates = soup.find_all(
        ["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "div"]
    )
    count = 0
    for el in candidates:
        # skip wrappers that contain other block elements
        if el.find(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li"]):
            continue
        txt = _clean(el.get_text(separator=" "))
        if re.match(r"^Article\s+\d+", txt, re.IGNORECASE):
            count += 1
            if count >= 2:
                return True
    return False


def _extract_decree_rows(content, meta: dict) -> list[dict]:
    """
    For JO summary pages structured as:
        h2 = JO header
        h3 = Ministry
        h4 = Decree / law title
    Each h4 becomes one row (type='decret').
    """
    rows: list[dict] = []
    current_ministry = ""

    for el in content.find_all(["h2", "h3", "h4", "h5", "p"]):
        txt = _clean(el.get_text(separator=" "))
        if not txt:
            continue
        if el.name == "h3":
            current_ministry = txt
        elif el.name in ("h4", "h5"):
            rows.append({
                **meta,
                "type":     "decret",
                "numero":   "",
                "contexte": current_ministry,
                "texte":    txt,
            })
        elif el.name == "p" and rows:
            rows[-1]["texte"] += " " + txt

    return rows


def _extract_article_rows(content, meta: dict) -> list[dict]:
    """For pages structured with 'Article N' headings (legal codes)."""
    rows: list[dict] = []
    elements = content.find_all(
        ["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "div"]
    )

    current_titre    = ""
    current_chapitre = ""
    current_section  = ""
    preamble_lines: list[str] = []
    in_preamble = True
    current_article_num  = ""
    current_article_text: list[str] = []

    def flush_article() -> None:
        nonlocal current_article_num, current_article_text
        if current_article_num:
            rows.append({
                **meta,
                "type":     "article",
                "numero":   current_article_num,
                "contexte": " | ".join(
                    filter(None, [current_titre, current_chapitre, current_section])
                ),
                "texte":    " ".join(current_article_text).strip(),
            })

    for el in elements:
        if el.find(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6"]):
            continue
        txt = _tag_text(el)
        if not txt:
            continue

        if RE_TITRE.match(txt):
            flush_article(); current_article_num, current_article_text = "", []; current_titre = txt; continue
        if RE_CHAPITRE.match(txt):
            flush_article(); current_article_num, current_article_text = "", []; current_chapitre, current_section = txt, ""; continue
        if RE_SECTION.match(txt):
            flush_article(); current_article_num, current_article_text = "", []; current_section = txt; continue
        if RE_ARTICLE.match(txt):
            flush_article()
            m = re.match(r"(Article\s+\d+(?:\s+bis|\s+ter)?)\s*[:.]?\s*(.*)", txt, re.IGNORECASE)
            if m:
                current_article_num  = m.group(1).strip()
                rest                 = m.group(2).strip()
                current_article_text = [rest] if rest else []
            else:
                current_article_num, current_article_text = txt, []
            in_preamble = False
            continue

        if in_preamble:
            preamble_lines.append(txt)
        elif current_article_num:
            current_article_text.append(txt)

    flush_article()
    if preamble_lines:
        rows.insert(0, {**meta, "type": "preambule", "numero": "", "contexte": "", "texte": " ".join(preamble_lines)})
    return rows


def extract_articles(html: str, title: str, url: str) -> list[dict]:
    """Auto-detect page type and extract rows accordingly."""
    if NO_SUMMARY in html:
        return []
    soup = BeautifulSoup(html, "lxml")
    content = (
        soup.find("div", class_=re.compile(r"entry-content|article-content|content|post-content", re.I))
        or soup.find("main")
        or soup.find("article")
        or soup.body
    )
    if content is None:
        return []
    meta = {"code": title, "source_url": url}
    if not _has_article_structure(html):
        return []   # skip decree-style pages without Article N structure
    return _extract_article_rows(content, meta)



# ---------------------------------------------------------------------------
# Step 3 — Scrape one entry (used by thread pool)
# ---------------------------------------------------------------------------

def scrape_entry(
    entry: dict,
    session: requests.Session,
) -> tuple[str, list[dict]]:
    """Fetch one JO entry and return (title, rows)."""
    title = entry["title"]
    slug  = entry["url"].lstrip("/")
    url   = f"{BASE_URL}/{slug}"

    try:
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
        resp.encoding = resp.apparent_encoding or "utf-8"
        rows = extract_articles(resp.text, title, url)
    except Exception as exc:
        print(f"  [ERREUR] {url}: {exc}")
        rows = []

    return title, rows


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scrape all Journal Officiel entries and extract articles."
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Process only the first N entries (useful for testing).",
    )
    parser.add_argument(
        "--start", type=int, default=0,
        help="Skip the first N entries (resume after a crash).",
    )
    parser.add_argument(
        "--workers", type=int, default=3,
        help="Number of parallel HTTP workers (default 3, be polite).",
    )
    parser.add_argument(
        "--delay", type=float, default=0.5,
        help="Seconds between requests per worker (default 0.5).",
    )
    args = parser.parse_args()

    DATA_DIR.mkdir(exist_ok=True)

    # 1. Get all entries
    print("=== Récupération de la liste des JO… ===")
    all_entries = fetch_all_entries()

    # Slice
    entries = all_entries[args.start:]
    if args.limit:
        entries = entries[: args.limit]

    print(f"\n=== Scraping {len(entries)} entrées "
          f"(workers={args.workers}, delay={args.delay}s) ===\n")

    # Combined output file (append-friendly)
    combined_path = DATA_DIR / "journal_officiel_tous.csv"
    combined_file = open(combined_path, "w", newline="", encoding="utf-8-sig")
    combined_writer = csv.DictWriter(combined_file, fieldnames=FIELDNAMES)
    combined_writer.writeheader()

    total_rows   = 0
    total_with   = 0
    total_skip   = 0

    def _worker(entry: dict) -> tuple[str, list[dict]]:
        session = requests.Session()
        session.headers.update(HEADERS)
        title, rows = scrape_entry(entry, session)
        time.sleep(args.delay)
        return title, rows

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(_worker, e): e for e in entries}
        done = 0
        for future in as_completed(futures):
            done += 1
            title, rows = future.result()

            if not rows:
                total_skip += 1
                print(f"  [{done}/{len(entries)}] SKIP  {title}")
                continue

            total_with += 1
            total_rows += len(rows)

            # Per-JO CSV  (sanitise title for filename)
            safe = re.sub(r"[^\w\-]", "_", title)[:80]
            out  = DATA_DIR / f"{safe}.csv"
            with open(out, "w", newline="", encoding="utf-8-sig") as f:
                w = csv.DictWriter(f, fieldnames=FIELDNAMES)
                w.writeheader()
                w.writerows(rows)

            combined_writer.writerows(rows)
            combined_file.flush()

            print(f"  [{done}/{len(entries)}] OK    {title}  → {len(rows)} lignes")

    combined_file.close()

    print(f"\n{'='*60}")
    print(f"✓ Entrées avec contenu : {total_with}")
    print(f"✗ Entrées ignorées     : {total_skip}")
    print(f"  Total lignes extraites : {total_rows}")
    print(f"  Fichier combiné : {combined_path}")


if __name__ == "__main__":
    main()
