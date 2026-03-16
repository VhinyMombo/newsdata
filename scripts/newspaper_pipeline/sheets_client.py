"""
sheets_client.py — shared Google Sheets helper for all scrapers.

Reads SHEET_ID from the GOOGLE_SHEETS_ID env var (or falls back to
looking in credentials.json if a 'SHEET_ID' key is present there).
Uses the Service Account in credentials.json for authentication.

Each scraper writes to its own tab:
    gabonreview | gabonmediatime | gabonactu | lunion

Usage:
    from scripts.newspaper_pipeline.sheets_client import SheetsClient
    client = SheetsClient()
    client.append_articles("gabonactu", articles, FIELDNAMES)
    rows = client.read_all_articles()
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import gspread
from google.oauth2.service_account import Credentials

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ROOT_DIR = Path(__file__).parent.parent.parent   # rag/
CREDS_FILE = ROOT_DIR / "credentials.json"

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

FIELDNAMES = ["category", "title", "published_time", "url", "text"]

# All known source tabs
ALL_TABS = ["gabonreview", "gabonmediatime", "gabonactu", "lunion"]

# Google Sheets has a hard limit of 50,000 characters per cell.
# We truncate slightly below that to stay safe.
MAX_CELL_CHARS = 48000


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class SheetsClient:
    """Thin wrapper around gspread for the newspaper pipeline."""

    def __init__(self) -> None:
        # Resolve Sheet ID: env var takes priority, then 'SHEET_ID' key in JSON
        sheet_id = os.getenv("GOOGLE_SHEETS_ID", "")
        if not sheet_id and CREDS_FILE.exists():
            raw = json.loads(CREDS_FILE.read_text())
            sheet_id = raw.get("SHEET_ID", "")
        if not sheet_id:
            raise ValueError(
                "Google Sheets ID not found. Set GOOGLE_SHEETS_ID env var "
                "or add 'SHEET_ID' key to credentials.json."
            )
        self._sheet_id = sheet_id

        # Authenticate
        if not CREDS_FILE.exists():
            raise FileNotFoundError(f"credentials.json not found at {CREDS_FILE}")
        creds = Credentials.from_service_account_file(str(CREDS_FILE), scopes=SCOPES)
        self._gc = gspread.authorize(creds)
        self._spreadsheet = self._gc.open_by_key(self._sheet_id)

    def _get_or_create_tab(self, tab_name: str) -> gspread.Worksheet:
        """Return worksheet for tab_name, creating it with a header row if needed."""
        try:
            ws = self._spreadsheet.worksheet(tab_name)
            # Verify headers - if wrong, force update them to match FIELDNAMES
            try:
                first_row = ws.row_values(1)
                if first_row != FIELDNAMES:
                    print(f"  ⚠️  Fixing headers for tab '{tab_name}'...")
                    ws.update("A1", [FIELDNAMES])
            except Exception:
                pass 
        except gspread.WorksheetNotFound:
            ws = self._spreadsheet.add_worksheet(title=tab_name, rows=1, cols=len(FIELDNAMES))
            # Use named arguments for update to avoid deprecation warnings
            ws.update(values=[FIELDNAMES], range_name="A1")
            print(f"  📋 Created new tab: '{tab_name}'")
        return ws

    def _existing_urls(self, ws: gspread.Worksheet) -> set[str]:
        """Return the set of URLs already in the worksheet (deduplication key)."""
        try:
            url_col_idx = FIELDNAMES.index("url") + 1  # 1-indexed
            all_vals = ws.col_values(url_col_idx)
            return set(all_vals[1:])  # skip header
        except Exception:
            return set()

    def append_articles(
        self,
        tab_name: str,
        articles: list[dict],
        fieldnames: list[str] | None = None,
    ) -> int:
        """
        Append new articles to the given tab.
        Only rows whose URL is not already present are added.
        Returns the number of rows actually written.
        """
        if not articles:
            return 0
        fieldnames = fieldnames or FIELDNAMES
        ws = self._get_or_create_tab(tab_name)
        existing = self._existing_urls(ws)

        new_rows = []
        for art in articles:
            url = str(art.get("url", "")).strip()
            if url and url not in existing:
                existing.add(url)
                # Ensure no single cell exceeds the character limit
                row = []
                for f in fieldnames:
                    val = str(art.get(f, ""))
                    if len(val) > MAX_CELL_CHARS:
                        val = val[:MAX_CELL_CHARS] + "... [TRUNCATED]"
                    row.append(val)
                new_rows.append(row)

        if new_rows:
            ws.append_rows(new_rows, value_input_option="RAW")
            print(f"  ✅ Appended {len(new_rows)} new rows to '{tab_name}'")
        else:
            print(f"  ⏭️  No new articles for '{tab_name}' (all already present)")

        return len(new_rows)

    def read_all_articles(
        self,
        tabs: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Read all rows from the specified tabs (default: all known tabs).
        Returns a list of dicts with an added 'source' key = tab name.
        """
        tabs = tabs or ALL_TABS
        all_rows: list[dict] = []

        for tab in tabs:
            try:
                ws = self._spreadsheet.worksheet(tab)
            except gspread.WorksheetNotFound:
                print(f"  ⚠️  Tab '{tab}' not found — skipping")
                continue

            records = ws.get_all_records(expected_headers=FIELDNAMES)
            for rec in records:
                rec["source"] = tab
                all_rows.append(rec)
            print(f"  📖 Read {len(records)} rows from '{tab}'")

        return all_rows
