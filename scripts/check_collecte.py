"""E-mails the admins when the front page stops receiving articles, whatever the cause:
the indexing crash of November 2026 stayed unnoticed for five days. One message per
incident, a reminder each day it lasts, and one when articles are back.
Runs from cron on the server, inside the pipeline image."""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import mailer  # noqa: E402

API_URL = os.getenv("CHECK_API_URL", "http://api:8000")
STATE_PATH = Path(os.getenv("CHECK_STATE_PATH", "/data/collecte_alert.json"))
# Long enough for a quiet night, short enough to catch a breakdown within the day
MAX_SILENCE = timedelta(hours=18)
REMIND_EVERY = timedelta(hours=24)
GABON = timezone(timedelta(hours=1))
LOG_FILE = "~/lekiosque/logs/pipeline_scheduled.log"


def newest_article(today: dict, now: datetime) -> datetime | None:
    """The latest publication time, ignoring a newspaper's date in the future."""
    times = []
    for article in today.get("latest") or []:
        try:
            when = datetime.fromisoformat((article.get("time") or "").replace("Z", "+00:00"))
        except ValueError:
            continue
        when = when if when.tzinfo else when.replace(tzinfo=GABON)
        if when <= now:
            times.append(when)
    return max(times, default=None)


def fetch_today() -> dict:
    with urllib.request.urlopen(f"{API_URL}/today", timeout=30) as response:
        return json.load(response)


def _label(when: datetime | None) -> str:
    return when.astimezone(GABON).strftime("%d/%m/%Y à %H h %M") if when else "inconnu"


def decide(problem: str | None, state: dict, now: datetime) -> tuple[tuple[str, str] | None, dict]:
    """What to send, if anything, and the state to keep once it has gone out."""
    if not problem:
        if not state.get("since"):
            return None, {}
        since = datetime.fromisoformat(state["since"])
        return ("Le Kiosque : la collecte a repris",
                f"Des articles arrivent de nouveau. Le problème avait été détecté le {_label(since)}."), {}
    if state.get("since"):
        if now - datetime.fromisoformat(state["last_sent"]) < REMIND_EVERY:
            return None, state
        subject = "Le Kiosque : rappel, la collecte est toujours en panne"
    else:
        subject = "Le Kiosque : la collecte semble en panne"
    text = f"{problem}\n\nJournal de la collecte sur le serveur : {LOG_FILE}"
    return (subject, text), {"since": state.get("since") or now.isoformat(), "last_sent": now.isoformat()}


def check(now: datetime | None = None) -> None:
    now = now or datetime.now(timezone.utc)
    try:
        newest = newest_article(fetch_today(), now)
        silent = newest is None or now - newest > MAX_SILENCE
        problem = f"Aucun nouvel article depuis plus de 18 heures. Dernier article reçu : {_label(newest)}." if silent else None
    except Exception as error:  # the API itself is down: readers see nothing either
        problem = f"Le site ne répond pas à la vérification : {type(error).__name__}."

    state = json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {}
    message, next_state = decide(problem, state, now)
    if message:
        recipients = sorted(e.strip() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip())
        if not (mailer.configured() and recipients):
            print(f"{now.isoformat()} NOT SENT, mail not configured: {message[0]}")
            return
        # A failed send raises before the state is saved, so the next check tries again
        for to in recipients:
            mailer.send(to, *message)
    STATE_PATH.write_text(json.dumps(next_state))
    print(f"{now.isoformat()} {'sent: ' + message[0] if message else 'nothing to send'}")


if __name__ == "__main__":
    check()
