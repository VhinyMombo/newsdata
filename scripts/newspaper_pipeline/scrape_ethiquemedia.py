#!/usr/bin/env python3
"""
Scrape Éthique Média Gabon articles published in the last N days.

The site is WordPress with plain permalinks (?p=ID) and an open REST API —
see wp_rest_scraper.py for the shared implementation.
Uploads results to the 'ethiquemediagabon' tab in Google Sheets.

Usage:
    python scripts/newspaper_pipeline/scrape_ethiquemedia.py             # last 3 days
    python scripts/newspaper_pipeline/scrape_ethiquemedia.py --days 25   # last 25 days
"""

from wp_rest_scraper import run_cli

if __name__ == "__main__":
    run_cli(
        base_url="https://ethiquemediagabon.net",
        tab_name="ethiquemediagabon",
        label="Éthique Média Gabon",
    )
