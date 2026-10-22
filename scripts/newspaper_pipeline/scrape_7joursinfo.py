#!/usr/bin/env python3
"""
Scrape 7 Jours Info articles published in the last N days.

The site is WordPress with an open REST API — see wp_rest_scraper.py.
Uploads results to the '7joursinfo' tab in Google Sheets.

Usage:
    python scripts/newspaper_pipeline/scrape_7joursinfo.py             # last 3 days
    python scripts/newspaper_pipeline/scrape_7joursinfo.py --days 25   # last 25 days
"""

from wp_rest_scraper import run_cli

if __name__ == "__main__":
    run_cli(
        base_url="https://7joursinfo.com",
        tab_name="7joursinfo",
        label="7 Jours Info",
    )
