#!/usr/bin/env python3
"""
Scrape Gabon Quotidien articles published in the last N days.

The site is WordPress with an open REST API — see wp_rest_scraper.py.
Uploads results to the 'gabonquotidien' tab in Google Sheets.

Usage:
    python scripts/newspaper_pipeline/scrape_gabonquotidien.py             # last 3 days
    python scripts/newspaper_pipeline/scrape_gabonquotidien.py --days 25   # last 25 days
"""

from wp_rest_scraper import run_cli

if __name__ == "__main__":
    run_cli(
        base_url="https://gabon-quotidien.com",
        tab_name="gabonquotidien",
        label="Gabon Quotidien",
    )
