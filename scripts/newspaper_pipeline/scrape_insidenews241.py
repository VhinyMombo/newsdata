#!/usr/bin/env python3
"""
Scrape Inside News 241 articles published in the last N days.

The site is WordPress with an open REST API — see wp_rest_scraper.py.
Uploads results to the 'insidenews241' tab in Google Sheets.

Usage:
    python scripts/newspaper_pipeline/scrape_insidenews241.py             # last 3 days
    python scripts/newspaper_pipeline/scrape_insidenews241.py --days 25   # last 25 days
"""

from wp_rest_scraper import run_cli

if __name__ == "__main__":
    run_cli(
        base_url="https://insidenews241.com",
        tab_name="insidenews241",
        label="Inside News 241",
    )
