#!/usr/bin/env python3
"""
Scrape Gabon Matin articles published in the last N days.

The site runs SPIP, not WordPress: its RSS feed (spip.php?page=backend) lists
only the 10 latest articles with a summary, so each new article's page is
fetched for the full text, its date and its section (article:published_time,
article:section, .article-text). For a backfill beyond those 10, --sitemap
reads the article URLs from sitemap.xml instead (its lastmod is the sitemap's
own regeneration time, so every page is fetched and kept by its own date).
robots.txt asks for a 1 s crawl delay, and URLs already in the sheet are not
fetched again.
Uploads results to the 'gabonmatin' tab in Google Sheets.

Usage:
    python scripts/newspaper_pipeline/scrape_gabonmatin.py                       # last 3 days
    python scripts/newspaper_pipeline/scrape_gabonmatin.py --days 210 --sitemap  # backfill
"""

from __future__ import annotations

import argparse
import re
import time
from datetime import datetime, timedelta

import requests
from bs4 import BeautifulSoup

from wp_rest_scraper import FIELDNAMES, LIBREVILLE

SITE = "https://gabonmatin.com"
FEED_URL = f"{SITE}/spip.php?page=backend"
SITEMAP_URL = f"{SITE}/sitemap.xml"
TAB_NAME = "gabonmatin"
HEADERS = {"User-Agent": "LeKiosque/1.0 (+https://lekiosque.hodologic.fr)"}
CRAWL_DELAY = 1  # seconds, from gabonmatin.com/robots.txt

_last_request = 0.0


def _get(url: str) -> requests.Response:
    """GET that keeps the site's crawl delay between any two requests."""
    global _last_request
    wait = CRAWL_DELAY - (time.monotonic() - _last_request)
    if _last_request and wait > 0:
        time.sleep(wait)
    _last_request = time.monotonic()
    return requests.get(url, headers=HEADERS, timeout=30)


def _feed_urls() -> list[str]:
    # The feed is not always well-formed XML: read it with the forgiving parser
    r = _get(FEED_URL)
    r.raise_for_status()
    return [link.get_text(strip=True) for link in BeautifulSoup(r.text, "xml").select("item > link")]


def _sitemap_urls() -> list[str]:
    r = _get(SITEMAP_URL)
    r.raise_for_status()
    # Section pages are named /-politique-.html; articles are not
    return [u for u in re.findall(r"<loc>([^<]+)</loc>", r.text)
            if u.endswith(".html") and not u.rsplit("/", 1)[-1].startswith("-")]


def _article(url: str) -> dict | None:
    """Title, date, section and full text of an article page; None if unreadable."""
    try:
        r = _get(url)
        if r.status_code != 200:
            return None
    except Exception as e:
        print(f"    [HTTP ERROR] {url}: {e}")
        return None
    soup = BeautifulSoup(r.text, "lxml")
    meta = lambda prop: (soup.find("meta", property=prop) or {}).get("content", "").strip()
    published, body = meta("article:published_time"), soup.select_one(".article-text")
    if not published or body is None:
        return None
    paragraphs = [p.get_text(" ", strip=True) for p in body.find_all(["p", "h2", "h3", "li"])]
    return {
        "category": (meta("article:section") or "actualité").lower(),
        "title": meta("og:title") or "Sans titre",
        "published": datetime.fromisoformat(published.replace("Z", "+00:00")).astimezone(LIBREVILLE),
        "url": url,
        "text": "\n\n".join(p for p in paragraphs if p),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape Gabon Matin via its RSS feed or sitemap.")
    parser.add_argument("--days", type=int, default=3, help="Days to look back (default: 3)")
    parser.add_argument("--sitemap", action="store_true", help="Read every article URL from the sitemap (backfill)")
    args = parser.parse_args()

    today = datetime.now(LIBREVILLE).replace(hour=0, minute=0, second=0, microsecond=0)
    since = today - timedelta(days=args.days - 1)
    print(f"=== Scraping Gabon Matin — since {since.date()} ({args.days} days) ===\n")

    from sheets_client import SheetsClient
    client = SheetsClient()
    known = client.existing_urls(TAB_NAME)

    try:
        urls = _sitemap_urls() if args.sitemap else _feed_urls()
    except Exception as e:
        print(f"    [HTTP ERROR] {e}")
        return

    rows = []
    for url in urls:
        if url in known:
            continue
        a = _article(url)
        if a is None or a["published"] < since or not a["text"]:
            continue
        rows.append({
            "category": a["category"],
            "title": a["title"],
            "published_time": a["published"].isoformat(),
            "url": url,
            "text": a["text"],
        })
        print(f"    ✓ [{rows[-1]['published_time'][:10]}] [{a['category']}] {a['title'][:65]}")

    if not rows:
        print("⚠️  No new articles for this period.")
        return

    print(f"{'='*60}")
    print(f"📤 Uploading {len(rows)} articles to Google Sheets...")
    written = client.append_articles(TAB_NAME, rows, FIELDNAMES)
    print(f"✅ Done — {written} new rows added to '{TAB_NAME}' tab")


if __name__ == "__main__":
    main()
