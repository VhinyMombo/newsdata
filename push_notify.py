"""push_notify.py — Web Push notifications for followed topics that spike.

Server-side port of the "spiked" half of computeFollowDeltas
(frontend/src/App.jsx:2403-2432): same threshold (today's count is at least
1.6x the trailing baseline), but anchored on "today vs the last 6 days"
instead of "since last visit vs an equal window before that", since there's
no per-user last-seen date to read from outside the browser. Only "spiked"
fires a push — "new"/"quiet" stay a UI-only concept (landing page delta
chips) so this doesn't turn into a daily notification for every one-off
mention.

title_words uses NLTK's French stopword corpus rather than mirroring
frontend/src/App.jsx's hand-picked TITLE_STOPWORDS (App.jsx:2390) — a
deliberate choice to use a standard, more complete list here, at the cost of
"is this word a stopword" no longer matching exactly what the frontend's
keyword-frequency chart considers a stopword. normalize_category lives in
api.py instead (also used by /widget/summary) and is called here as
api.normalize_category.

Requires the NLTK 'stopwords' corpus downloaded once per machine:
    .venv/bin/python -c "import nltk; nltk.download('stopwords')"

Called from scripts/generate_scheduled_report.py's daily (not weekly) run,
after the report is archived, so it reuses the same freshly-indexed corpus.
"""

from __future__ import annotations

import json
import logging
import os
import re

from nltk.corpus import stopwords
from pywebpush import WebPushException, webpush

import api
import auth

log = logging.getLogger("push_notify")

SPIKE_RATIO = 1.6

TITLE_STOPWORDS = set(stopwords.words("french"))

_WORD_RE = re.compile(r"[^a-zàâéèêëïîôùûüÿçœæ\s-]")


def title_words(title: str) -> set[str]:
    cleaned = _WORD_RE.sub("", (title or "").lower())
    return {w for w in cleaned.split() if len(w) > 2 and w not in TITLE_STOPWORDS}


def _matches(item: dict, row: tuple) -> bool:
    _date, source, category, title, _url = row
    if item["type"] == "source":
        return source == item["value"]
    if item["type"] == "theme":
        return api.normalize_category(category, source) == item["value"]
    if item["type"] == "keyword":
        # A followed name can be several words ("oligui nguema"): match it in the
        # lowercased title, like the front page does, not against single words
        value = item["value"].lower()
        return value in title_words(title) if " " not in value else value in (title or "").lower()
    return False


def _spiked_follows(follows: list[dict], since_rows: list[tuple], baseline_rows: list[tuple]) -> list[dict]:
    spiked = []
    for item in follows:
        since_count = sum(1 for r in since_rows if _matches(item, r))
        baseline_count = sum(1 for r in baseline_rows if _matches(item, r))
        if since_count > 0 and baseline_count > 0 and since_count / baseline_count >= SPIKE_RATIO:
            spiked.append({**item, "since_count": since_count, "baseline_count": baseline_count})
    return spiked


def send_spike_notifications() -> None:
    vapid_private_key = os.getenv("VAPID_PRIVATE_KEY")
    if not api.VAPID_PUBLIC_KEY or not vapid_private_key:
        log.warning("VAPID keys not configured (.env) — skipping push notifications.")
        return

    vapid_claims_sub = os.getenv("VAPID_SUBJECT", "mailto:admin@example.com")

    _start, _now, rows = api._collect_week(days=7)
    today_str = api.gabon_today().isoformat()
    since_rows = [r for r in rows if r[0] == today_str]
    baseline_rows = [r for r in rows if r[0] != today_str]
    if not since_rows:
        log.info("No articles today — nothing to check for spikes.")
        return

    users = auth.list_push_subscriptions_with_follows()
    sent, pruned = 0, 0
    for entry in users:
        spiked = _spiked_follows(entry["follows"], since_rows, baseline_rows)
        if not spiked:
            continue

        labels = [f["label"] for f in spiked]
        title = "Ça bouge sur vos sujets suivis" if len(labels) > 1 else f"Ça bouge sur « {labels[0]} »"
        body = ", ".join(labels) if len(labels) > 1 else (
            f"{spiked[0]['since_count']} articles aujourd'hui, contre "
            f"{spiked[0]['baseline_count']} en moyenne récemment."
        )
        payload = json.dumps({"title": title, "body": body, "url": "/"})

        for sub in entry["subscriptions"]:
            try:
                webpush(
                    subscription_info={
                        "endpoint": sub["endpoint"],
                        "keys": {"p256dh": sub["p256dh"], "auth": sub["auth_key"]},
                    },
                    data=payload,
                    vapid_private_key=vapid_private_key,
                    vapid_claims={"sub": vapid_claims_sub},
                )
                sent += 1
            except WebPushException as e:
                status = getattr(e.response, "status_code", None)
                if status in (404, 410):
                    auth.remove_push_subscription_by_endpoint(sub["endpoint"])
                    pruned += 1
                else:
                    log.warning("webpush failed for endpoint %s: %s", sub["endpoint"][:50], e)

    log.info("push_notify: %d notifications sent, %d stale subscriptions pruned.", sent, pruned)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    send_spike_notifications()
