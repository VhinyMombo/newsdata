#!/usr/bin/env python3
"""
Scrape Dépêches 241 articles published in the last N days.

The site is WordPress with plain permalinks (?p=ID) and an open REST API —
see wp_rest_scraper.py for the shared implementation.
Uploads results to the 'depeches241' tab in Google Sheets.

Usage:
    python scripts/newspaper_pipeline/scrape_depeches241.py             # last 3 days
    python scripts/newspaper_pipeline/scrape_depeches241.py --days 25   # last 25 days
"""

from wp_rest_scraper import run_cli

if __name__ == "__main__":
    run_cli(
        base_url="https://depeches241.com",
        tab_name="depeches241",
        label="Dépêches 241",
    )
