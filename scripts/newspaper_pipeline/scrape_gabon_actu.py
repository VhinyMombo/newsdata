#!/usr/bin/env python3
"""
Scrape GabonActu articles published in the last N days, per category.

URL pattern (confirmed working):
    https://gabonactu.com/blog/category/economie/
    https://gabonactu.com/blog/category/economie/page/2/

Category is taken from the URL (since each page is category-specific),
and the article's own `div.cat-links` is used as a fallback.

Saves results to:
    Newspaperdata/gabonactu_<today>.csv

Usage:
    python scripts/newspaper_pipeline/scrape_gabon_actu.py              # last 3 days
    python scripts/newspaper_pipeline/scrape_gabon_actu.py --days 90   # last 90 days
"""

from __future__ import annotations

import argparse
import csv
import re
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT_DIR = Path(__file__).parent.parent.parent   # rag/
DATA_DIR = ROOT_DIR / "Newspaperdata"

BASE_URL = "https://gabonactu.com"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
}

# Category slugs — confirmed URL: /blog/category/<slug>/
ALL_CATEGORIES = [
    "politique",
    "economie",
    "societe",
    "sports",
    "culture",
    "sante",
    "international",
    "faits-divers",
]

FIELDNAMES = ["category", "title", "published_time", "url", "text"]

SKIP_PATTERNS = {"facebook.com", "twitter.com", "whatsapp", "youtube.com", "#", "?share"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_article_links_from_page(url: str) -> list[str]:
    """Return deduplicated article URLs from a listing page."""
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
        if any(s in href for s in SKIP_PATTERNS):
            continue
        # Article URLs: /blog/YYYY/MM/DD/slug/
        if href.startswith(BASE_URL) and re.search(r"/[0-9]{4}/[0-9]{2}/[0-9]{2}/[^/?]+/?$", href):
            links.add(href.rstrip("/") + "/")

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

    # Date
    meta_date = soup.find("meta", property="article:published_time")
    pub_time = meta_date["content"] if meta_date else ""

    # Category — from div.cat-links on article page; fallback to category URL slug
    cat_div = soup.find("div", class_="cat-links")
    if cat_div:
        cat_a = cat_div.find("a")
        category = (cat_a.get_text(strip=True) if cat_a else cat_div.get_text(strip=True)).lower()
    else:
        category = default_category

    # Title
    h1 = soup.find("h1", class_="entry-title") or soup.find("h1")
    if h1:
        title = h1.get_text(strip=True)
    elif soup.title:
        title = re.sub(r"\s*[-|]\s*Gabonactu.*$", "", soup.title.string or "", flags=re.IGNORECASE).strip()
    else:
        title = "Sans titre"

    # Body text
    content_div = soup.find("div", class_="entry-content")
    text = ""
    if content_div:
        paragraphs = content_div.find_all("p")
        text = "\n\n".join(p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True))

    return {
        "category": category,
        "title": title,
        "url": url,
        "published_time": pub_time,
        "text": text,
    }


# ---------------------------------------------------------------------------
# Per-category scraping loop
# ---------------------------------------------------------------------------

def scrape_category(category: str, target_dates: set[str]) -> list[dict]:
    """
    Paginate /blog/category/<slug>/page/N/ and collect articles
    whose published date falls within target_dates.
    Stops after 2 consecutive pages with zero matches.
    """
    rows: list[dict] = []
    seen_urls: set[str] = set()
    page = 1
    consecutive_misses = 0

    while True:
        if page == 1:
            page_url = f"{BASE_URL}/blog/category/{category}/"
        else:
            page_url = f"{BASE_URL}/blog/category/{category}/page/{page}/"

        links = _get_article_links_from_page(page_url)
        if not links:
            break

        new_links = [l for l in links if l not in seen_urls]
        seen_urls.update(new_links)

        page_matches = 0
        for url in new_links:
            article = _fetch_article(url, default_category=category)
            if article is None:
                continue
            pub = article["published_time"][:10]
            if pub in target_dates:
                rows.append(article)
                page_matches += 1
                print(f"    ✓ [{pub}] [{article['category']}] {article['title'][:65]}")
            time.sleep(0.25)

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
    parser = argparse.ArgumentParser(description="Scrape GabonActu by category.")
    parser.add_argument("--categories", nargs="+", default=ALL_CATEGORIES)
    parser.add_argument("--days", type=int, default=3, help="Days to look back (default: 3)")
    args = parser.parse_args()

    DATA_DIR.mkdir(exist_ok=True)

    now = datetime.now()
    target_dates: set[str] = {
        (now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(args.days)
    }
    date_min, date_max = min(target_dates), max(target_dates)

    print(f"=== Scraping GabonActu — {date_min} → {date_max} ({args.days} days) ===")
    print(f"    Categories: {', '.join(args.categories)}\n")

    all_articles: list[dict] = []
    seen_urls: set[str] = set()

    for cat in args.categories:
        print(f"📂 [{cat}]")
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

    today_str = date.today().isoformat()
    csv_path = DATA_DIR / f"gabonactu_{today_str}.csv"
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(all_articles)

    print(f"{'='*60}")
    print(f"✅ Saved {len(all_articles)} unique articles → {csv_path}")


if __name__ == "__main__":
    main()
