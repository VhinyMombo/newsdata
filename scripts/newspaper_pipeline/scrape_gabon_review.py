#!/usr/bin/env python3
"""
Scrape all GabonReview articles published in the last N days, across all categories.

The script paginates through each category until it finds no more articles
matching the target date range. Saves results to Newspaperdata/gabonreview_<start>_to_<end>.csv.

Usage:
    python scripts/scrape_gabon_review.py                  # last 3 days, all categories
    python scripts/scrape_gabon_review.py --days 7         # last 7 days
    python scripts/scrape_gabon_review.py --categories politique economie
"""

from __future__ import annotations

import argparse
import csv
import re
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT_DIR = Path(__file__).parent.parent
DATA_DIR = ROOT_DIR / "Newspaperdata"

BASE_URL = "https://www.gabonreview.com"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
}

# All categories visible on the site
ALL_CATEGORIES = [
    "politique",
    "economie",
    "societe-et-politique",   # Société
    "sport",
    "enviro",                 # Environnement
    "culture",
    "faits_divers",
    "afrique",
    "sosconso",
]

FIELDNAMES = ["category", "title", "published_time", "url", "text"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_article_links_from_page(url: str) -> list[str]:
    """Return unique article URLs found on a single listing page."""
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
    except Exception as e:
        print(f"    [HTTP ERROR] {url}: {e}")
        return []

    soup = BeautifulSoup(r.text, "lxml")
    links: set[str] = set()

    for a in soup.find_all(
        "a", href=re.compile(r"^https://www\.gabonreview\.com/[a-z0-9]")
    ):
        href = a["href"]
        # Keep only actual article URLs (exclude category / page / author / feed / etc.)
        if any(x in href for x in ("/category/", "/page/", "/author/", "/feed", "/tag/",
                                     "/wp-", "/xmlrpc", "/comments/", "/qui-sommes",
                                     "/mentions-", "/contact/", "/charte-")):
            continue
        # Must end with / and not have # (comment anchors)
        if "#" in href:
            continue
        links.add(href)

    return list(links)


def _fetch_article(url: str) -> dict | None:
    """Fetch and parse a single article page. Returns dict or None on failure."""
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
    except Exception as e:
        print(f"    [HTTP ERROR] {url}: {e}")
        return None

    soup = BeautifulSoup(r.text, "lxml")

    # Published date
    meta_date = soup.find("meta", property="article:published_time")
    pub_time = meta_date["content"] if meta_date else ""

    # Title
    title = ""
    if soup.title:
        title = soup.title.string or ""
        title = title.replace("| Gabonreview.com | Actualité du Gabon |", "").strip()
    if not title:
        h1 = soup.find("h1")
        title = h1.get_text(strip=True) if h1 else "Sans titre"

    # Body text
    content_div = soup.find("div", class_=re.compile(r"post-single|entry-content|post-content"))
    text = ""
    if content_div:
        paragraphs = content_div.find_all("p")
        text = "\n\n".join(p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True))

    return {
        "title": title,
        "url": url,
        "published_time": pub_time,
        "text": text,
    }


# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------

def scrape_category(category: str, target_dates: set[str]) -> list[dict]:
    """
    Paginate through a category, collecting all articles whose published date
    matches any of the target_dates (set of "YYYY-MM-DD" strings).
    Stops when two consecutive pages have zero matches.
    """
    rows: list[dict] = []
    seen_urls: set[str] = set()
    page = 1
    consecutive_misses = 0

    while True:
        if page == 1:
            page_url = f"{BASE_URL}/category/{category}/"
        else:
            page_url = f"{BASE_URL}/category/{category}/page/{page}/"

        links = _get_article_links_from_page(page_url)
        if not links:
            break

        new_links = [l for l in links if l not in seen_urls]
        seen_urls.update(new_links)

        page_matches = 0
        for url in new_links:
            article = _fetch_article(url)
            if article is None:
                continue
            pub = article["published_time"][:10]  # "YYYY-MM-DD"
            if pub in target_dates:
                article["category"] = category
                rows.append(article)
                page_matches += 1
                print(f"    ✓ [{pub}] {article['title'][:75]}")
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


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scrape GabonReview articles from the last N days across all categories."
    )
    parser.add_argument(
        "--categories", nargs="+", default=ALL_CATEGORIES,
        help="Categories to scrape (default: all)",
    )
    parser.add_argument(
        "--days", type=int, default=3,
        help="Number of days to look back (default: 3, i.e. today + 2 previous days)",
    )
    args = parser.parse_args()

    DATA_DIR.mkdir(exist_ok=True)

    # Build the set of target dates
    today = datetime.now()
    target_dates: set[str] = set()
    for i in range(args.days):
        d = today - timedelta(days=i)
        target_dates.add(d.strftime("%Y-%m-%d"))

    date_min = min(target_dates)
    date_max = max(target_dates)

    print(f"=== Scraping GabonReview — {date_min} to {date_max} ({args.days} days) ===")
    print(f"    Categories: {', '.join(args.categories)}\n")

    all_articles: list[dict] = []
    seen_urls: set[str] = set()

    for cat in args.categories:
        print(f"📂 Category: {cat}")
        cat_rows = scrape_category(cat, target_dates)

        # Deduplicate (an article can appear in multiple categories)
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

    # Sort by date descending
    all_articles.sort(key=lambda r: r["published_time"], reverse=True)

    today = date.today().isoformat()
    csv_path = DATA_DIR / f"gabonreview_{today}.csv"
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(all_articles)

    print(f"{'='*60}")
    print(f"✅ Saved {len(all_articles)} unique articles to {csv_path}")


if __name__ == "__main__":
    main()
