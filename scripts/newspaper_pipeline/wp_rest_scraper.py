"""
wp_rest_scraper.py — shared scraper for WordPress sites with an open REST API.

Used by scrape_depeches241.py and scrape_7joursinfo.py. Instead of parsing
HTML listings we page through:

    <base_url>/?rest_route=/wp/v2/posts&after=<ISO>&page=N

Category names are resolved via /wp/v2/categories. The ?rest_route= form
works with plain permalinks (?p=ID) as well as pretty ones.
"""

from __future__ import annotations

import argparse
import time
from datetime import datetime, timedelta

import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
}

FIELDNAMES = ["category", "title", "published_time", "url", "text"]

PER_PAGE = 50


def _rest_get(base_url: str, route: str, params: dict) -> requests.Response:
    """Call the WP REST API using the ?rest_route= form."""
    query = {"rest_route": route, **params}
    return requests.get(base_url, params=query, headers=HEADERS, timeout=20)


def fetch_category_map(base_url: str) -> dict[int, str]:
    """Map category ID → name (paginated)."""
    cats: dict[int, str] = {}
    page = 1
    while True:
        try:
            r = _rest_get(base_url, "/wp/v2/categories", {
                "per_page": 100, "page": page, "_fields": "id,name",
            })
            if r.status_code != 200:
                break
            batch = r.json()
        except Exception as e:
            print(f"    [HTTP ERROR] categories page {page}: {e}")
            break
        if not batch:
            break
        for c in batch:
            cats[c["id"]] = str(c.get("name", "")).strip().lower()
        if len(batch) < 100:
            break
        page += 1
    return cats


def _html_to_text(html: str) -> str:
    """Strip tags, keep paragraph structure."""
    soup = BeautifulSoup(html, "lxml")
    paragraphs = [p.get_text(" ", strip=True) for p in soup.find_all(["p", "h2", "h3", "li"])]
    text = "\n\n".join(p for p in paragraphs if p)
    return text or soup.get_text(" ", strip=True)


def scrape_posts(base_url: str, target_dates: set[str], cat_map: dict[int, str]) -> list[dict]:
    """Page through /wp/v2/posts (newest first) until dates fall out of range."""
    after_iso = f"{min(target_dates)}T00:00:00"
    rows: list[dict] = []
    page = 1

    while True:
        try:
            r = _rest_get(base_url, "/wp/v2/posts", {
                "after": after_iso,
                "per_page": PER_PAGE,
                "page": page,
                "orderby": "date",
                "order": "desc",
                "_fields": "id,link,title,date,content,categories",
            })
            # WP returns 400 (rest_post_invalid_page_number) past the last page
            if r.status_code != 200:
                break
            posts = r.json()
        except Exception as e:
            print(f"    [HTTP ERROR] posts page {page}: {e}")
            break
        if not posts:
            break

        for p in posts:
            pub_time = str(p.get("date", ""))
            pub_date = pub_time[:10]
            if pub_date not in target_dates:
                continue

            title = BeautifulSoup(p.get("title", {}).get("rendered", ""), "lxml").get_text(strip=True)
            text = _html_to_text(p.get("content", {}).get("rendered", ""))
            if not text:
                continue

            cat_ids = p.get("categories") or []
            category = next((cat_map[c] for c in cat_ids if c in cat_map), "actualité")

            rows.append({
                "category": category,
                "title": title or "Sans titre",
                "published_time": pub_time,
                "url": str(p.get("link", "")),
                "text": text,
            })
            print(f"    ✓ [{pub_date}] [{category}] {title[:65]}")

        if len(posts) < PER_PAGE:
            break
        page += 1
        time.sleep(0.5)

    return rows


def run_cli(base_url: str, tab_name: str, label: str) -> None:
    """Argparse entry point shared by all WP REST scrapers."""
    parser = argparse.ArgumentParser(description=f"Scrape {label} via the WP REST API.")
    parser.add_argument("--days", type=int, default=3, help="Days to look back (default: 3)")
    args = parser.parse_args()

    now = datetime.now()
    target_dates: set[str] = {
        (now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(args.days)
    }
    date_min, date_max = min(target_dates), max(target_dates)

    print(f"=== Scraping {label} — {date_min} → {date_max} ({args.days} days) ===\n")

    cat_map = fetch_category_map(base_url)
    print(f"    {len(cat_map)} categories resolved\n")

    all_articles = scrape_posts(base_url, target_dates, cat_map)

    if not all_articles:
        print("⚠️  No articles found for this period.")
        return

    # Deduplicate by URL, newest first
    seen: set[str] = set()
    unique = []
    for row in sorted(all_articles, key=lambda r: r["published_time"], reverse=True):
        if row["url"] not in seen:
            seen.add(row["url"])
            unique.append(row)

    print(f"{'='*60}")
    print(f"📤 Uploading {len(unique)} articles to Google Sheets...")
    from sheets_client import SheetsClient
    client = SheetsClient()
    written = client.append_articles(tab_name, unique, FIELDNAMES)
    print(f"✅ Done — {written} new rows added to '{tab_name}' tab")
