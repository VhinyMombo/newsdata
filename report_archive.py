"""report_archive.py — SQLite archive of generated daily/weekly reports.

Every completed report (streamed or PDF) is saved once, so past editions
stay browsable instead of vanishing after the in-memory cache is evicted.
Also the storage layer a cron-triggered scheduled generation writes to
(scripts/generate_scheduled_report.py) — no email delivery yet, that needs
SMTP credentials and a recipient-management decision first.

Schema is intentionally minimal: enough to browse and re-read a past
edition, not enough to regenerate its PDF (that would need the exact
article list at generation time, which isn't stored — a v2 concern).
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

# Overridable so a container can put the file on a mounted volume instead of
# in the (rebuilt, throwaway) image layer next to the source.
DB_PATH = Path(
    os.getenv("REPORTS_DB_PATH") or Path(__file__).parent / "reports_archive.db"
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL CHECK (kind IN ('daily', 'weekly')),
    period_start  TEXT NOT NULL,   -- ISO date, window start
    period_end    TEXT NOT NULL,   -- ISO date, window end (generation day)
    article_count INTEGER NOT NULL,
    text          TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_kind_created ON reports(kind, created_at DESC);
"""


@contextmanager
def _conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(_SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


def save_report(kind: str, period_start: str, period_end: str,
                article_count: int, text: str) -> int:
    """Persist a completed report. Skips near-duplicate saves (same kind +
    period_end + article_count already archived — the daily cron and a
    manual click on the same day would otherwise both write an entry)."""
    with _conn() as conn:
        existing = conn.execute(
            "SELECT id FROM reports WHERE kind = ? AND period_end = ? AND article_count = ?",
            (kind, period_end, article_count),
        ).fetchone()
        if existing:
            return existing["id"]
        cur = conn.execute(
            "INSERT INTO reports (kind, period_start, period_end, article_count, text) "
            "VALUES (?, ?, ?, ?, ?)",
            (kind, period_start, period_end, article_count, text),
        )
        return cur.lastrowid


def list_reports(kind: str | None = None, limit: int = 30) -> list[dict]:
    """Newest first. Excerpt only (first ~200 chars) — full text via get_report."""
    with _conn() as conn:
        q = "SELECT id, kind, period_start, period_end, article_count, created_at, " \
            "substr(text, 1, 220) AS excerpt FROM reports"
        params: list = []
        if kind:
            q += " WHERE kind = ?"
            params.append(kind)
        q += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        return [dict(r) for r in conn.execute(q, params).fetchall()]


def get_report(report_id: int) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
        return dict(row) if row else None


def latest_id(kind: str | None = None) -> int | None:
    with _conn() as conn:
        q = "SELECT id FROM reports"
        params: list = []
        if kind:
            q += " WHERE kind = ?"
            params.append(kind)
        q += " ORDER BY id DESC LIMIT 1"
        row = conn.execute(q, params).fetchone()
        return row["id"] if row else None
