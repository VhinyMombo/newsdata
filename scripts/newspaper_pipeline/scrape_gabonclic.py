#!/usr/bin/env python3
"""
Scrape Gabonclic articles published in the last N days.

The site is WordPress with an open REST API — see wp_rest_scraper.py.
Uploads results to the 'gabonclic' tab in Google Sheets.

Usage:
    python scripts/newspaper_pipeline/scrape_gabonclic.py             # last 3 days
    python scripts/newspaper_pipeline/scrape_gabonclic.py --days 25   # last 25 days
"""

from wp_rest_scraper import run_cli

if __name__ == "__main__":
    run_cli(
        base_url="https://gabonclic.info",
        tab_name="gabonclic",
        label="Gabonclic",
    )
