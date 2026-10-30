"""push_notify.py — Web Push notifications: the daily brief and the weekly
review for readers who asked for them in their profile, and an alert on
followed topics that spike. Each link carries n=<kind>, which the app counts
as an opened notification (frontend/src/utils/notifOpen.js) and then drops.

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
from datetime import timedelta

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


MONTHS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet",
          "août", "septembre", "octobre", "novembre", "décembre")

BRIEF_BODY_CHARS = 180

_SENTENCE_END_RE = re.compile(r"(?<=[.!?…])\s")
_HEADING_RE = re.compile(r"#+ .*|\*\*[^*\n]+\*\*")


def _vapid() -> tuple[str, str] | None:
    vapid_private_key = os.getenv("VAPID_PRIVATE_KEY")
    if not api.VAPID_PUBLIC_KEY or not vapid_private_key:
        log.warning("VAPID keys not configured (.env) — skipping push notifications.")
        return None
    return vapid_private_key, os.getenv("VAPID_SUBJECT", "mailto:admin@example.com")


def _send(subscriptions: list[dict], payload: str, vapid: tuple[str, str]) -> tuple[int, int]:
    """Push one payload to each subscription; drop those the push service says are gone."""
    vapid_private_key, vapid_claims_sub = vapid
    sent, pruned = 0, 0
    for sub in subscriptions:
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
    return sent, pruned


def brief_title(day) -> str:
    return f"Le résumé du {'1er' if day.day == 1 else day.day} {MONTHS[day.month - 1]}"


def brief_body(text: str) -> str:
    """The brief's opening sentence, without its markdown, cut on a word if too long.
    A heading standing alone above the first paragraph is skipped."""
    paragraphs = [p for p in (text or "").strip().split("\n\n") if p.strip()] or [""]
    first = next((p for p in paragraphs if not _HEADING_RE.fullmatch(p.strip())), paragraphs[0])
    first = re.sub(r"[*_#>`]+", "", first).strip()
    first = _SENTENCE_END_RE.split(first, 1)[0]
    if len(first) <= BRIEF_BODY_CHARS:
        return first
    return first[:BRIEF_BODY_CHARS].rsplit(" ", 1)[0].rstrip(",;:") + "…"


def send_edition(kind: str, report_id: int, text: str) -> None:
    """Called once an edition is archived (kind "daily" or "weekly"): one
    notification per device of each reader who turned it on, opening that
    edition in the Éditions."""
    vapid = _vapid()
    if not vapid:
        return
    pref, mark, title = (
        ("daily_brief", "jour", brief_title(api.gabon_today())) if kind == "daily"
        else ("weekly_review", "semaine", "La revue de la semaine")
    )
    payload = json.dumps({
        "title": title,
        "body": brief_body(text),
        "url": f"/#/editions/archive?id={report_id}&n={mark}",
    })
    sent, pruned = _send(auth.list_subscriptions_for(pref), payload, vapid)
    log.info("%s: %d notifications sent, %d stale subscriptions pruned.", pref, sent, pruned)


def send_spike_notifications() -> None:
    vapid = _vapid()
    if not vapid:
        return

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
        payload = json.dumps({"title": title, "body": body, "url": "/#/?n=sujets"})
        s, p = _send(entry["subscriptions"], payload, vapid)
        sent, pruned = sent + s, pruned + p

    log.info("push_notify: %d notifications sent, %d stale subscriptions pruned.", sent, pruned)


# ── General notifications: every device that accepted them, no account needed ──

# Display names, as in frontend/src/utils/format.js SOURCE_LABELS
SOURCE_LABELS = {
    "gabonreview": "Gabonreview", "gabonmediatime": "Gabon Media Time", "gabonactu": "Gabonactu",
    "lunion": "L'Union", "depeches241": "Dépêches 241", "7joursinfo": "7 Jours Info",
    "ethiquemediagabon": "Éthique Média", "focusgroupemedia": "Focus Groupe Média",
    "gabonallsport": "Gabon All Sport", "gabonquotidien": "Gabon Quotidien",
    "directinfosgabon": "Direct Infos Gabon", "insidenews241": "Inside News 241",
    "kongossanews": "Kongossa News", "agpgabon": "AGP Gabon", "gabonclic": "Gabonclic",
    "gabonmailinfos": "Gabon Mail Infos", "medias241": "Médias241", "gabonmatin": "Gabon Matin",
}

# Two articles from different newspapers are the same story when their stored
# embeddings (embeddinggemma, first chunk) are at least this close. Tried on
# 111 articles over 36 hours (22/10/2026): 0.8 groups the cement plant at
# Akanda across 6 papers and the withdrawn gold permits across 4, without
# merging unrelated stories; 0.85 already splits them.
STORY_SIMILARITY = 0.8
# A story becomes "toute la presse en parle" when this many newspapers carry it
# within WAVE_HOURS, and is announced once; at most one such alert a day
WAVE_MIN_SOURCES = 4
WAVE_HOURS = 12
MORNING_STORIES = 3


def _stories(start) -> list[dict]:
    """Articles published since `start`, grouped by story, the most widely
    covered first: [{title, source, url, sources, urls}], where title/source/url
    are those of the article closest to the story's centre."""
    import numpy as np

    res = api._collection.get(
        where={"published_ts": {"$gte": api.gabon_timestamp(start)}},
        include=["metadatas", "embeddings"],
    )
    # One entry per article: its first chunk (older articles carry no chunk field)
    keep = [i for i, m in enumerate(res["metadatas"] or []) if m and not m.get("chunk", 0)]
    if not keep:
        return []
    metas = [res["metadatas"][i] for i in keep]
    vectors = np.asarray([res["embeddings"][i] for i in keep], dtype=float)
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    sim = vectors @ vectors.T

    # Single-link grouping across newspapers (a paper's two articles on one
    # story are not the press picking it up)
    parent = list(range(len(metas)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(metas)):
        for j in range(i + 1, len(metas)):
            if sim[i, j] >= STORY_SIMILARITY and metas[i].get("source") != metas[j].get("source"):
                parent[root(i)] = root(j)
    groups: dict[int, list[int]] = {}
    for i in range(len(metas)):
        groups.setdefault(root(i), []).append(i)

    stories = []
    for members in groups.values():
        centre = vectors[members].mean(axis=0)
        lead = metas[max(members, key=lambda k: float(vectors[k] @ centre))]
        stories.append({
            "title": (lead.get("title") or "").strip(),
            "source": lead.get("source", ""),
            "url": lead.get("source_url", ""),
            "sources": sorted({metas[k].get("source", "") for k in members}),
            "urls": sorted({metas[k].get("source_url", "") for k in members}),
            "latest": max(float(metas[k].get("published_ts") or 0) for k in members),
        })
    stories.sort(key=lambda s: (len(s["sources"]), s["latest"]), reverse=True)
    return stories


def _send_general(pref: str, payload: dict, vapid: tuple[str, str]) -> int:
    sent, pruned = _send(auth.list_devices_for(pref), json.dumps(payload), vapid)
    log.info("%s: %d notifications sent, %d stale subscriptions pruned.", pref, sent, pruned)
    return sent


def _short(title: str, limit: int = 72) -> str:
    return title if len(title) <= limit else title[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "…"


def _ask_url(question: str, mark: str) -> str:
    """Opens the assistant on this question (App.jsx reads q), counted as mark."""
    from urllib.parse import quote
    return f"/#/assistant?q={quote(question)}&n={mark}"


def send_morning() -> None:
    """L'essentiel du matin (7:30): the three most covered stories since the
    evening before, each with its newspaper. Once a day."""
    vapid = _vapid()
    if not vapid:
        return
    today = api.gabon_today().isoformat()
    if auth.notifications_sent("morning", today):
        log.info("morning: already sent today.")
        return
    start = (api.gabon_now() - timedelta(days=1)).replace(hour=18, minute=0, second=0, microsecond=0)
    stories = [s for s in _stories(start) if s["title"]][:MORNING_STORIES]
    if not stories:
        log.info("morning: no article since yesterday evening — nothing sent.")
        return
    body = "\n".join(f"• {_short(s['title'])} ({SOURCE_LABELS.get(s['source'], s['source'])})" for s in stories)
    sent = _send_general("morning", {"title": "L'essentiel du matin", "body": body, "url": "/#/?n=matin"}, vapid)
    auth.log_notification("morning", today, [u for s in stories for u in s["urls"]], stories[0]["title"], sent)


def send_wave() -> None:
    """Toute la presse en parle: a story at least WAVE_MIN_SOURCES newspapers
    carried in the last WAVE_HOURS, announced once, one alert a day at most.
    Opens the assistant on that story, with every newspaper's article."""
    vapid = _vapid()
    if not vapid:
        return
    now = api.gabon_now()
    today = now.date().isoformat()
    if auth.notifications_sent("wave", today):
        log.info("wave: already sent today.")
        return
    announced = {
        u for row in auth.notifications_sent("wave", (now.date() - timedelta(days=3)).isoformat())
        for u in row["keys"].split("\n") if u
    }
    story = next(
        (s for s in _stories(now - timedelta(hours=WAVE_HOURS))
         if len(s["sources"]) >= WAVE_MIN_SOURCES and s["title"] and not announced.intersection(s["urls"])),
        None,
    )
    if not story:
        log.info("wave: no story carried by %d newspapers — nothing sent.", WAVE_MIN_SOURCES)
        return
    payload = {
        "title": "Toute la presse en parle",
        "body": f"{_short(story['title'], 110)} — repris par {len(story['sources'])} journaux en quelques heures.",
        "url": _ask_url(f"Que dit la presse sur « {story['title']} » ?", "vague"),
    }
    sent = _send_general("wave", payload, vapid)
    auth.log_notification("wave", today, story["urls"], story["title"], sent)


def announce(title: str, body: str, url: str = "/", test_user_id: int | None = None) -> int:
    """An announcement written in #/diffusion: to every device that takes
    them, or only to the sender's own devices for a test."""
    vapid = _vapid()
    if not vapid:
        return 0
    # Only a page of the app, marked so its openings are counted
    url = url if url.startswith("/#/") else "/#/"
    payload = {"title": title, "body": body, "url": f"{url}{'&' if '?' in url else '?'}n=annonce"}
    if test_user_id is not None:
        sent, _ = _send(auth.list_user_subscriptions(test_user_id), json.dumps(payload), vapid)
        return sent
    sent = _send_general("alerts", payload, vapid)
    auth.log_notification("alerts", api.gabon_today().isoformat(), [], title, sent)
    return sent


if __name__ == "__main__":
    # python push_notify.py [spikes|morning|wave]; spikes when nothing is given
    import sys
    logging.basicConfig(level=logging.INFO)
    {"spikes": send_spike_notifications, "morning": send_morning, "wave": send_wave}[
        sys.argv[1] if len(sys.argv) > 1 else "spikes"
    ]()
