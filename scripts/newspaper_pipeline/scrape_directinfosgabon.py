#!/usr/bin/env python3
"""
Scrape Direct Infos Gabon articles published in the last N days.

The site is WordPress with an open REST API — see wp_rest_scraper.py.
Uploads results to the 'directinfosgabon' tab in Google Sheets.

Usage:
    python scripts/newspaper_pipeline/scrape_directinfosgabon.py             # last 3 days
    python scripts/newspaper_pipeline/scrape_directinfosgabon.py --days 25   # last 25 days
"""

from wp_rest_scraper import run_cli

if __name__ == "__main__":
    run_cli(
        base_url="https://directinfosgabon.com",
        tab_name="directinfosgabon",
        label="Direct Infos Gabon",
    )
