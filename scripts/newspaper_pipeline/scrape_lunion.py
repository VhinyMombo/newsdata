#!/usr/bin/env python3
"""
Scrape L'Union (union.sonapresse.com) articles published in the last N days.

The site is Drupal-based. Category pages use ?page=0, ?page=1, etc.
Article body is in div.field--name-body.  No article:published_time meta tag,
so the date is extracted from a visible <time> element or <span class="date-display-single">.

Saves results to:
    Newspaperdata/lunion_<timestamp>.csv

Usage:
    python scripts/newspaper_pipeline/scrape_lunion.py              # last 3 days
    python scripts/newspaper_pipeline/scrape_lunion.py --days 90    # last 90 days
"""

from __future__ import annotations

import argparse
import csv
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import unquote

import requests
from bs4 import BeautifulSoup

ROOT_DIR = Path(__file__).parent.parent.parent   # rag/
DATA_DIR = ROOT_DIR / "Newspaperdata"

BASE_URL = "https://www.union.sonapresse.com"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
}

# Category slugs as they appear in the URL path
ALL_CATEGORIES = [
    "politique",
    "%C3%A9conomie",                # économie
    "soci%C3%A9t%C3%A9-et-culture", # société-et-culture
    "faits-divers-et-justice",
    "sport",
    "provinces",
]

# Human-readable names for display
CATEGORY_LABELS = {
    "politique": "politique",
    "%C3%A9conomie": "économie",
    "soci%C3%A9t%C3%A9-et-culture": "société & culture",
    "faits-divers-et-justice": "faits divers & justice",
    "sport": "sport",
    "provinces": "provinces",
}

FIELDNAMES = ["category", "title", "published_time", "url", "text"]

# French month names → month number
FR_MONTHS = {
    "janvier": 1, "février": 2, "mars": 3, "avril": 4,
    "mai": 5, "juin": 6, "juillet": 7, "août": 8,
    "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_date(text: str) -> str:
    """
    Try to extract a YYYY-MM-DD date from a date string.
    Handles formats like:
      - 'Mar 12, 2026'  /  'March 12, 2026'
      - '12 mars 2026'  /  'mercredi 12 mars 2026'
      - '2026-03-12'
    Returns '' if parsing fails.
    """
    if not text:
        return ""
    text = text.strip()

    # ISO format already?
    m = re.search(r"(\d{4}-\d{2}-\d{2})", text)
    if m:
        return m.group(1)

    # English short/long: "Mar 12, 2026" or "March 12, 2026" or "12 March 2026"
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y"):
        try:
            dt = datetime.strptime(text.strip(",. "), fmt)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            continue

    # French: "12 mars 2026" or "mercredi 12 mars 2026"
    text_lower = text.lower()
    m = re.search(
        r"(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+(\d{4})",
        text_lower,
    )
    if m:
        day, month_name, year = m.group(1), m.group(2), m.group(3)
        month = FR_MONTHS.get(month_name, 0)
        if month:
            return f"{year}-{month:02d}-{int(day):02d}"

    return ""


def _get_article_links_from_page(url: str) -> list[str]:
    """Return deduplicated article URLs from a category listing page."""
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        if r.status_code == 404:
            return []
        r.raise_for_status()
    except Exception as e:
        print(f"    [HTTP ERROR] {url}: {e}")
        return []

    soup = BeautifulSoup(r.text, "lxml")
    links: set[str] = set()

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        # Normalise relative URLs
        if href.startswith("/fr/") and not href.startswith("http"):
            href = BASE_URL + href

        if not href.startswith(BASE_URL + "/fr/"):
            continue

        # Skip non-article links
        path = href.replace(BASE_URL, "")
        if any(x in path for x in (
            "/user/", "/taxonomy/", "/contact", "/form/",
            "/feed", "/node/", "?page=", "/tag/", "/author",
            "/qui_somme", "/equipe_", "/lunion-50",
            "/chroniques", "/legislatives",
        )):
            continue

        # Skip category pages themselves
        skip = False
        for cat in ALL_CATEGORIES:
            decoded_cat = unquote(cat)
            if path.rstrip("/") == f"/fr/{decoded_cat}" or path.rstrip("/") == f"/fr/{cat}":
                skip = True
                break
        if skip:
            continue

        # Must be a slug-style article URL (no further slashes after /fr/slug)
        clean = path.rstrip("/")
        parts = clean.split("/")
        if len(parts) == 3 and parts[1] == "fr" and len(parts[2]) > 5:
            links.add(href.rstrip("/"))

    return list(links)


def _fetch_article(url: str, default_category: str) -> dict | None:
    """Fetch and parse a single article page."""
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
    except Exception as e:
        print(f"    [HTTP ERROR] {url}: {e}")
        return None

    soup = BeautifulSoup(r.text, "lxml")

    # Title
    h1 = soup.find("h1")
    if h1:
        title = h1.get_text(strip=True)
    elif soup.title:
        title = soup.title.string or "Sans titre"
        title = re.sub(r"\s*\|.*$", "", title).strip()
    else:
        title = "Sans titre"

    # Date — L'Union uses <span/div class="post-created"> for the article's real date.
    # NOTE: <span class="created"> are sidebar items and show TODAY's date, not the article's!
    pub_date = ""

    # Primary: class="post-created" e.g. "13 February 2026"
    post_created = soup.find(class_="post-created")
    if post_created:
        pub_date = _parse_date(post_created.get_text(strip=True))

    # Fallback: <time datetime="...">
    if not pub_date:
        time_el = soup.find("time")
        if time_el:
            pub_date = _parse_date(time_el.get("datetime", "") or time_el.get_text(strip=True))

    # Fallback: meta article:published_time
    if not pub_date:
        meta = soup.find("meta", property="article:published_time")
        if meta and meta.get("content"):
            pub_date = _parse_date(meta["content"])

    # Category from breadcrumb or default
    category = default_category
    breadcrumb = soup.find("nav", class_=re.compile(r"breadcrumb", re.I))
    if breadcrumb:
        crumb_links = breadcrumb.find_all("a")
        if len(crumb_links) >= 2:
            category = crumb_links[-1].get_text(strip=True).lower()

    # Body text
    content_div = soup.find("div", class_="field--name-body")
    if not content_div:
        content_div = soup.find("div", class_=re.compile(r"node__content"))
    text = ""
    if content_div:
        paragraphs = content_div.find_all("p")
        text = "\n\n".join(p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True))

    return {
        "category": category,
        "title": title,
        "url": url,
        "published_time": pub_date,
        "text": text,
    }


# ---------------------------------------------------------------------------
# Per-category scraping loop
# ---------------------------------------------------------------------------

def scrape_category(category: str, target_dates: set[str]) -> list[dict]:
    """
    Paginate through /fr/<category>?page=N and collect articles
    whose published date falls within target_dates.
    Stops after 2 consecutive pages with zero matches.
    """
    rows: list[dict] = []
    seen_urls: set[str] = set()
    page = 0
    consecutive_misses = 0
    label = CATEGORY_LABELS.get(category, unquote(category))

    while True:
        if page == 0:
            page_url = f"{BASE_URL}/fr/{category}"
        else:
            page_url = f"{BASE_URL}/fr/{category}?page={page}"

        links = _get_article_links_from_page(page_url)
        if not links:
            break

        new_links = [l for l in links if l not in seen_urls]
        seen_urls.update(new_links)

        page_matches = 0
        for url in new_links:
            article = _fetch_article(url, default_category=label)
            if article is None:
                continue

            pub = article["published_time"]
            if pub in target_dates:
                rows.append(article)
                page_matches += 1
                print(f"    ✓ [{pub}] [{article['category']}] {article['title'][:65]}")
            time.sleep(0.3)

        if page_matches == 0:
            consecutive_misses += 1
            if consecutive_misses >= 2:
                break
        else:
            consecutive_misses = 0

        page += 1
        time.sleep(0.5)

    return rows


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape L'Union articles by category.")
    parser.add_argument("--categories", nargs="+", default=ALL_CATEGORIES)
    parser.add_argument("--days", type=int, default=3, help="Days to look back (default: 3)")
    args = parser.parse_args()

    DATA_DIR.mkdir(exist_ok=True)

    now = datetime.now()
    target_dates: set[str] = {
        (now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(args.days)
    }
    date_min, date_max = min(target_dates), max(target_dates)

    print(f"=== Scraping L'Union — {date_min} → {date_max} ({args.days} days) ===")
    print(f"    Categories: {', '.join(CATEGORY_LABELS.get(c, c) for c in args.categories)}\n")

    all_articles: list[dict] = []
    seen_urls: set[str] = set()

    for cat in args.categories:
        label = CATEGORY_LABELS.get(cat, unquote(cat))
        print(f"📂 [{label}]")
        cat_rows = scrape_category(cat, target_dates)
        new = 0
        for row in cat_rows:
            if row["url"] not in seen_urls:
                seen_urls.add(row["url"])
                all_articles.append(row)
                new += 1
        print(f"   → {len(cat_rows)} found, {new} new unique\n")

    if not all_articles:
        print("⚠️  No articles found for this period.")
        return

    all_articles.sort(key=lambda r: r["published_time"], reverse=True)

    print(f"{'='*60}")
    print(f"📤 Uploading {len(all_articles)} articles to Google Sheets...")
    from sheets_client import SheetsClient
    client = SheetsClient()
    written = client.append_articles("lunion", all_articles, FIELDNAMES)
    print(f"✅ Done — {written} new rows added to 'lunion' tab")


if __name__ == "__main__":
    main()

