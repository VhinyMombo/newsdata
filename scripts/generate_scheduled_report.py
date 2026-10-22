"""generate_scheduled_report.py — cron entry point for automatic report generation.

Generates the daily (default) or weekly (--weekly) report and saves it to
the local archive (report_archive.py, reports_archive.db), without needing
api.py's HTTP server running — imports api.py directly, same pattern as
scripts/backfill_categories.py.

This only produces and archives the text. There is no delivery mechanism
yet: that needs SMTP credentials and a recipient-management decision first.
Once those exist, a delivery step can read the freshly archived report
(report_archive.latest_id(kind)) and send it, without touching this script.

Usage:
    .venv/bin/python scripts/generate_scheduled_report.py            # daily
    .venv/bin/python scripts/generate_scheduled_report.py --weekly   # weekly

Suggested cron entry (Gabon morning, matches the whitepaper's 10h scrape so
the day's first batch of articles is already indexed):
    0 9 * * * cd /path/to/rag && .venv/bin/python scripts/generate_scheduled_report.py >> logs/scheduled_report.log 2>&1
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import api  # noqa: E402  (loads Chroma + Ollama once, same as backfill_categories.py)
import push_notify  # noqa: E402
import report_archive  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weekly", action="store_true",
                    help="generate the weekly report instead of the daily one")
    args = ap.parse_args()
    daily = not args.weekly
    kind = "daily" if daily else "weekly"

    start, now, rows = api._collect_report(daily)
    if not rows:
        print(f"[{kind}] no articles in window ({start.date()} → {now.date()}), skipping.")
        return

    messages, *_ = api._weekly_messages(start, now, rows, daily=daily)
    print(f"[{kind}] generating from {len(rows)} articles "
          f"({start.date()} → {now.date()})…", flush=True)

    try:
        text = api._report_llm.invoke(messages).content.strip()
    except Exception as e:
        print(f"[{kind}] LLM generation failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Same truncation guard as the live /daily_report and /weekly_report
    # endpoints (api._maybe_cache_report) — an unattended run must not
    # silently archive a response cut short by the context limit
    if not text or text[-1] not in ".!?»)":
        print(f"[{kind}] output looks truncated, not archiving.", file=sys.stderr)
        sys.exit(1)

    rid = report_archive.save_report(
        kind, start.date().isoformat(), now.date().isoformat(), len(rows), text,
    )
    print(f"[{kind}] archived as report #{rid} ({len(text)} chars, {len(rows)} articles).")

    # Spike notifications use a fixed "today vs trailing week" window (see
    # push_notify.py), so they only make sense to run once a day, alongside
    # the daily report — not on the weekly run.
    if daily:
        try:
            push_notify.send_spike_notifications()
        except Exception as e:
            print(f"[{kind}] push notification check failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
