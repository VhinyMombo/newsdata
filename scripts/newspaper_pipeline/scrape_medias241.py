#!/usr/bin/env python3
"""
Scrape Médias241 articles published in the last N days.

The site closes its WordPress REST API (401) but publishes an open RSS feed,
paged with ?paged=N. The feed carries only a summary, so each new article's
page is fetched for the full text. robots.txt asks for a 60 s crawl delay:
every request waits that long, and URLs already in the sheet are not fetched
again, so the hourly run costs one or two requests.
Uploads results to the 'medias241' tab in Google Sheets.

Usage:
    python scripts/newspaper_pipeline/scrape_medias241.py             # last 3 days
    python scripts/newspaper_pipeline/scrape_medias241.py --days 25   # last 25 days
"""

from __future__ import annotations

import argparse
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import requests
from bs4 import BeautifulSoup

from wp_rest_scraper import FIELDNAMES, LIBREVILLE

FEED_URL = "https://medias241.com/feed/"
TAB_NAME = "medias241"
HEADERS = {"User-Agent": "LeKiosque/1.0 (+https://lekiosque.hodologic.fr)"}
CRAWL_DELAY = 60  # seconds, from medias241.com/robots.txt
CONTENT_NS = "{http://purl.org/rss/1.0/modules/content/}encoded"

_last_request = 0.0


def _get(url: str, params: dict | None = None) -> requests.Response:
    """GET that keeps the site's crawl delay between any two requests."""
    global _last_request
    wait = CRAWL_DELAY - (time.monotonic() - _last_request)
    if _last_request and wait > 0:
        time.sleep(wait)
    _last_request = time.monotonic()
    return requests.get(url, params=params, headers=HEADERS, timeout=30)


def _feed_items(since: datetime) -> list[dict]:
    """Feed entries published since `since`, newest first, across feed pages."""
    items: list[dict] = []
    page = 1
    while True:
        try:
            r = _get(FEED_URL, {"paged": page} if page > 1 else None)
            if r.status_code != 200:
                break
            root = ET.fromstring(r.content)
        except Exception as e:
            print(f"    [HTTP ERROR] feed page {page}: {e}")
            break
        entries = root.findall("./channel/item")
        if not entries:
            break
        for it in entries:
            published = parsedate_to_datetime(it.findtext("pubDate", ""))
            if published < since:
                return items
            summary = it.findtext(CONTENT_NS) or it.findtext("description") or ""
            items.append({
                "url": it.findtext("link", "").strip(),
                "title": BeautifulSoup(it.findtext("title", ""), "lxml").get_text(strip=True),
                "published_time": published.astimezone(LIBREVILLE).isoformat(),
                "category": next((c.text.strip().lower() for c in it.findall("category") if c.text), "actualité"),
                "summary": BeautifulSoup(summary, "lxml").get_text(" ", strip=True),
            })
        page += 1
    return items


def _article_text(url: str) -> str:
    """Full text of an article page; empty if the page can't be read."""
    try:
        r = _get(url)
        if r.status_code != 200:
            return ""
    except Exception as e:
        print(f"    [HTTP ERROR] {url}: {e}")
        return ""
    body = BeautifulSoup(r.text, "lxml").select_one(".newsx-post-content")
    if body is None:
        return ""
    paragraphs = [p.get_text(" ", strip=True) for p in body.find_all(["p", "h2", "h3", "li"])]
    return "\n\n".join(p for p in paragraphs if p)


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape Médias241 via its RSS feed.")
    parser.add_argument("--days", type=int, default=3, help="Days to look back (default: 3)")
    args = parser.parse_args()

    today = datetime.now(LIBREVILLE).replace(hour=0, minute=0, second=0, microsecond=0)
    since = today - timedelta(days=args.days - 1)
    print(f"=== Scraping Médias241 — since {since.date()} ({args.days} days) ===\n")

    from sheets_client import SheetsClient
    client = SheetsClient()
    known = client.existing_urls(TAB_NAME)

    rows = []
    for item in _feed_items(since.astimezone(timezone.utc)):
        if not item["url"] or item["url"] in known:
            continue
        text = _article_text(item["url"]) or item["summary"]
        if not text:
            continue
        rows.append({
            "category": item["category"],
            "title": item["title"] or "Sans titre",
            "published_time": item["published_time"],
            "url": item["url"],
            "text": text,
        })
        print(f"    ✓ [{item['published_time'][:10]}] [{item['category']}] {item['title'][:65]}")

    if not rows:
        print("⚠️  No new articles for this period.")
        return

    print(f"{'='*60}")
    print(f"📤 Uploading {len(rows)} articles to Google Sheets...")
    written = client.append_articles(TAB_NAME, rows, FIELDNAMES)
    print(f"✅ Done — {written} new rows added to '{TAB_NAME}' tab")


if __name__ == "__main__":
    main()
