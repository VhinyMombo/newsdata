#!/usr/bin/env python3
"""
Scraper pour le Journal Officiel de la République Gabonaise.
Lit les URLs depuis codes_list.yml et extrait les articles en CSV.
"""

import re
import csv
import time
import yaml
import requests
from bs4 import BeautifulSoup
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent
ROOT_DIR   = SCRIPT_DIR.parent          # project root (rag/)
YAML_FILE  = ROOT_DIR / "codes_list.yml"
OUTPUT_DIR = ROOT_DIR / "data"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def fetch_html(url: str) -> BeautifulSoup:
    """Fetch a URL and return a BeautifulSoup object."""
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    resp.encoding = resp.apparent_encoding or "utf-8"
    return BeautifulSoup(resp.text, "html.parser")


def clean(text: str) -> str:
    """Strip excess whitespace from a string."""
    return " ".join(text.split()).strip()


# ---------------------------------------------------------------------------
# Parsing logic
# ---------------------------------------------------------------------------

# Regex patterns
RE_ARTICLE   = re.compile(r"^Article\s+\d+", re.IGNORECASE)
RE_CHAPITRE  = re.compile(r"^Chapitre\s+", re.IGNORECASE)
RE_SECTION   = re.compile(r"^Section\s+|^Sous-section\s+", re.IGNORECASE)
RE_TITRE     = re.compile(r"^Titre\s+|^TITRE\s+", re.IGNORECASE)


def _tag_text(tag) -> str:
    return clean(tag.get_text(separator=" "))


def extract_articles(soup: BeautifulSoup, code_name: str, url: str):
    """
    Walk through the page DOM and extract:
      - preamble (text before first Article)
      - each article (number, title/section context, full text)

    Returns a list of dicts with keys:
      code, source_url, type, numero, contexte, texte
    """
    rows = []
    meta = {
        "code": code_name,
        "source_url": url,
    }

    # --- Locate the main content area ---
    # The Journal Officiel pages put article text inside divs / paragraphs.
    # Try common selectors in order.
    content = (
        soup.find("div", class_=re.compile(r"entry-content|article-content|content|post-content", re.I))
        or soup.find("main")
        or soup.find("article")
        or soup.body
    )

    if content is None:
        print(f"  [WARN] Could not find content element for {url}")
        return rows

    # Collect all text-bearing elements in document order
    elements = content.find_all(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "div"])

    # Walk through and accumulate
    current_titre    = ""
    current_chapitre = ""
    current_section  = ""
    preamble_lines   = []
    in_preamble      = True

    current_article_num  = ""
    current_article_text = []

    def flush_article():
        nonlocal current_article_num, current_article_text
        if current_article_num:
            rows.append({
                **meta,
                "type":     "article",
                "numero":   current_article_num,
                "contexte": " | ".join(filter(None, [current_titre, current_chapitre, current_section])),
                "texte":    " ".join(current_article_text).strip(),
            })

    for el in elements:
        # Skip purely structural wrappers that contain child elements we'll
        # visit anyway (avoid duplicating text from nested tags).
        if el.find(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6"]):
            continue

        txt = _tag_text(el)
        if not txt:
            continue

        # --- Structural headings ---
        if RE_TITRE.match(txt):
            flush_article()
            current_article_num  = ""
            current_article_text = []
            current_titre = txt
            continue

        if RE_CHAPITRE.match(txt):
            flush_article()
            current_article_num  = ""
            current_article_text = []
            current_chapitre = txt
            current_section  = ""
            continue

        if RE_SECTION.match(txt):
            flush_article()
            current_article_num  = ""
            current_article_text = []
            current_section = txt
            continue

        # --- Article start ---
        if RE_ARTICLE.match(txt):
            flush_article()
            # Extract number, e.g. "Article 42 : ..."
            m = re.match(r"(Article\s+\d+(?:\s+bis|\s+ter)?)\s*[:.]?\s*(.*)", txt, re.IGNORECASE)
            if m:
                current_article_num  = m.group(1).strip()
                rest                 = m.group(2).strip()
                current_article_text = [rest] if rest else []
            else:
                current_article_num  = txt
                current_article_text = []
            in_preamble = False
            continue

        # --- Body text ---
        if in_preamble:
            preamble_lines.append(txt)
        else:
            if current_article_num:
                current_article_text.append(txt)

    # Flush last article
    flush_article()

    # Add preamble as a single row
    if preamble_lines:
        rows.insert(0, {
            **meta,
            "type":     "preambule",
            "numero":   "",
            "contexte": "",
            "texte":    " ".join(preamble_lines),
        })

    return rows


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    # Load YAML
    with open(YAML_FILE, encoding="utf-8") as f:
        codes = yaml.safe_load(f)

    if not codes:
        print("Aucun code trouvé dans le fichier YAML.")
        return

    OUTPUT_DIR.mkdir(exist_ok=True)

    all_rows = []

    for code_name, config in codes.items():
        url = config.get("path", "").strip()
        if not url:
            print(f"[SKIP] {code_name} — pas d'URL.")
            continue

        print(f"\n{'='*60}")
        print(f"Code  : {code_name}")
        print(f"URL   : {url}")

        try:
            soup = fetch_html(url)
        except Exception as e:
            print(f"[ERREUR] Impossible de récupérer {url}: {e}")
            continue

        rows = extract_articles(soup, code_name, url)
        print(f"  → {len(rows)} ligne(s) extraite(s)")

        # Per-code CSV
        out_file = OUTPUT_DIR / f"{code_name}.csv"
        fieldnames = ["code", "source_url", "type", "numero", "contexte", "texte"]
        with open(out_file, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        print(f"  Sauvegardé → {out_file}")

        all_rows.extend(rows)
        time.sleep(1)  # Be polite to the server

    # Combined CSV with all codes
    combined_file = OUTPUT_DIR / "tous_les_codes.csv"
    fieldnames = ["code", "source_url", "type", "numero", "contexte", "texte"]
    with open(combined_file, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_rows)

    print(f"\n{'='*60}")
    print(f"✓ Total : {len(all_rows)} ligne(s) dans {combined_file}")


if __name__ == "__main__":
    main()
