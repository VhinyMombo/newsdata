"""auth.py — user accounts, sessions, and per-user followed topics.

SQLite-backed, same pattern as report_archive.py: no new service, no new
pip dependency beyond bcrypt (already installed for something else in this
env — check before adding it elsewhere). Sessions are opaque random tokens
in a table, not JWTs — a DB row you can delete is a real logout; a stateless
JWT isn't, without a blocklist that's just this table by another name.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import hmac
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

import bcrypt

# Overridable so a container can put the file on a mounted volume instead of
# in the (rebuilt, throwaway) image layer next to the source.
DB_PATH = Path(os.getenv("AUTH_DB_PATH") or Path(__file__).parent / "auth.db")
SESSION_TTL_DAYS = 30

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    -- Set once the address is proven (reset link, or Google vouching for it).
    -- Signing up proves nothing: nothing may be trusted on the address before this.
    email_verified_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS follows (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('keyword', 'source', 'theme')),
    value      TEXT NOT NULL,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, type, value),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth_key   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
-- What a reader asked to be notified of, across all their devices; the alert on
-- followed topics needs no row (following a topic is the opt-in)
CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id       INTEGER PRIMARY KEY,
    daily_brief   INTEGER NOT NULL DEFAULT 0,
    weekly_review INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
-- Every device that accepted notifications, signed in or not, and the general
-- notifications it takes (all on by default): the morning essentials, a story
-- the whole press picks up, and announcements sent from #/diffusion. The
-- endpoint is the device's secret address at its push service.
CREATE TABLE IF NOT EXISTS devices (
    endpoint   TEXT PRIMARY KEY,
    p256dh     TEXT NOT NULL,
    auth_key   TEXT NOT NULL,
    morning    INTEGER NOT NULL DEFAULT 1,
    wave       INTEGER NOT NULL DEFAULT 1,
    alerts     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- General notifications already sent, so a story is announced once and the
-- daily caps hold across runs
CREATE TABLE IF NOT EXISTS notification_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    kind    TEXT NOT NULL,
    day     TEXT NOT NULL,
    keys    TEXT NOT NULL DEFAULT '',
    title   TEXT NOT NULL DEFAULT '',
    sent    INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notification_log_day ON notification_log(kind, day);
-- Answers shared on WhatsApp from the assistant: the short link /r/<id> opens them
-- as they were written, with their sources. Only answers the API itself wrote.
CREATE TABLE IF NOT EXISTS shares (
    id         TEXT PRIMARY KEY,
    corpus     TEXT NOT NULL,
    question   TEXT NOT NULL,
    headline   TEXT NOT NULL DEFAULT '',
    answer     TEXT NOT NULL,
    sources    TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT NOT NULL,
    user_id    INTEGER NOT NULL,
    corpus     TEXT NOT NULL CHECK (corpus IN ('presse', 'codes')),
    title      TEXT NOT NULL,
    turns      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_recent ON conversations(user_id, updated_at);
CREATE TABLE IF NOT EXISTS identities (
    provider   TEXT NOT NULL CHECK (provider IN ('google', 'facebook')),
    subject    TEXT NOT NULL,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider, subject),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
-- Installed app on a phone: Google or Facebook opens in a browser sheet over the
-- app, so the app waits for the result under a secret it holds. Whoever sent the
-- sign-in link may know that secret too: the session is released only against the
-- code shown at the end of the sign-in, to the person who signed in.
CREATE TABLE IF NOT EXISTS app_logins (
    app_hash   TEXT PRIMARY KEY,
    user_id    INTEGER,
    error      TEXT,
    expires_at TEXT NOT NULL,
    code_hash  TEXT,
    attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS login_codes (
    code_hash  TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
-- Readers' ideas and problems for the app (#/suggestions), with or without an
-- account; the team sorts them by status
CREATE TABLE IF NOT EXISTS suggestions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER,
    kind       TEXT NOT NULL CHECK (kind IN ('idee', 'probleme', 'autre')),
    message    TEXT NOT NULL,
    contact    TEXT NOT NULL DEFAULT '',
    page       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'nouvelle'
               CHECK (status IN ('nouvelle', 'retenue', 'faite', 'ecartee')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_suggestions_recent ON suggestions(status, id);
"""

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AuthError(Exception):
    """User-facing auth failure (bad credentials, duplicate email, ...)."""


@contextmanager
def _conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.executescript(_SCHEMA)
        _migrate_notification_prefs(conn)
        _migrate_devices(conn)
        _migrate_sign_in_trust(conn)
        yield conn
        conn.commit()
    finally:
        conn.close()


def _migrate_sign_in_trust(conn: sqlite3.Connection) -> None:
    if "email_verified_at" not in {r["name"] for r in conn.execute("PRAGMA table_info(users)")}:
        conn.execute("ALTER TABLE users ADD COLUMN email_verified_at TEXT")
        # Google only ever linked or created these accounts with an address it vouched for
        conn.execute("UPDATE users SET email_verified_at = datetime('now') WHERE id IN "
                     "(SELECT user_id FROM identities WHERE provider = 'google')")
    if "code_hash" not in {r["name"] for r in conn.execute("PRAGMA table_info(app_logins)")}:
        conn.execute("ALTER TABLE app_logins ADD COLUMN code_hash TEXT")
        conn.execute("ALTER TABLE app_logins ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0")
    # The reader's Clerk account (clerk_auth.py), once they have signed in through it
    if "clerk_user_id" not in {r["name"] for r in conn.execute("PRAGMA table_info(users)")}:
        conn.execute("ALTER TABLE users ADD COLUMN clerk_user_id TEXT")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_clerk ON users(clerk_user_id) "
                 "WHERE clerk_user_id IS NOT NULL")


# Accounts opened through Facebook with a phone number have no e-mail: they get
# a unique address on a reserved domain (RFC 2606) that never receives mail
NO_EMAIL_DOMAIN = "comptes.lekiosque.invalid"


def _public_user(row: sqlite3.Row) -> dict:
    email = "" if row["email"].endswith("@" + NO_EMAIL_DOMAIN) else row["email"]
    return {"id": row["id"], "email": email, "display_name": row["display_name"],
            "email_verified": bool(row["email_verified_at"])}


def create_user(email: str, password: str, display_name: str) -> tuple[dict, str]:
    email = email.strip().lower()
    display_name = display_name.strip()
    if not _EMAIL_RE.match(email):
        raise AuthError("Adresse e-mail invalide.")
    if len(password) < 8:
        raise AuthError("Le mot de passe doit contenir au moins 8 caractères.")
    if not display_name:
        raise AuthError("Le nom affiché ne peut pas être vide.")

    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    with _conn() as conn:
        existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if existing:
            raise AuthError("Un compte existe déjà avec cette adresse e-mail.")
        cur = conn.execute(
            "INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)",
            (email, password_hash, display_name),
        )
        user_row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
        token = _create_session(conn, cur.lastrowid)
        return _public_user(user_row), token


def authenticate(email: str, password: str) -> tuple[dict, str]:
    email = email.strip().lower()
    with _conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        # Same error for "no such user" and "wrong password" — distinguishing
        # them tells an attacker which emails are registered
        if not row or not bcrypt.checkpw(password.encode(), row["password_hash"].encode()):
            raise AuthError("E-mail ou mot de passe incorrect.")
        token = _create_session(conn, row["id"])
        return _public_user(row), token


def _create_session(conn: sqlite3.Connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.utcnow() + timedelta(days=SESSION_TTL_DAYS)).isoformat()
    conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
        (token, user_id, expires_at),
    )
    return token


def get_user_by_token(token: str) -> dict | None:
    if not token:
        return None
    with _conn() as conn:
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token = ? AND s.expires_at > ?",
            (token, datetime.utcnow().isoformat()),
        ).fetchone()
        return _public_user(row) if row else None


def delete_session(token: str) -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


def update_profile(user_id: int, display_name: str | None = None,
                    current_password: str | None = None, new_password: str | None = None) -> dict:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise AuthError("Compte introuvable.")

        if new_password is not None:
            if not current_password or not bcrypt.checkpw(current_password.encode(), row["password_hash"].encode()):
                raise AuthError("Mot de passe actuel incorrect.")
            if len(new_password) < 8:
                raise AuthError("Le nouveau mot de passe doit contenir au moins 8 caractères.")
            new_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
            conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, user_id))

        if display_name is not None:
            display_name = display_name.strip()
            if not display_name:
                raise AuthError("Le nom affiché ne peut pas être vide.")
            conn.execute("UPDATE users SET display_name = ? WHERE id = ?", (display_name, user_id))

        updated = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _public_user(updated)


# ── Followed topics (per user) ──────────────────────────────────────────────

def list_follows(user_id: int) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT type, value, label FROM follows WHERE user_id = ? ORDER BY created_at",
            (user_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def add_follow(user_id: int, type_: str, value: str, label: str) -> None:
    if type_ not in ("keyword", "source", "theme"):
        raise AuthError("Type de suivi invalide.")
    with _conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO follows (user_id, type, value, label) VALUES (?, ?, ?, ?)",
            (user_id, type_, value, label),
        )


def remove_follow(user_id: int, type_: str, value: str) -> None:
    with _conn() as conn:
        conn.execute(
            "DELETE FROM follows WHERE user_id = ? AND type = ? AND value = ?",
            (user_id, type_, value),
        )


# ── Push subscriptions (per user) ───────────────────────────────────────────

def add_push_subscription(user_id: int, endpoint: str, p256dh: str, auth_key: str) -> None:
    with _conn() as conn:
        conn.execute(
            "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth_key) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, "
            "p256dh = excluded.p256dh, auth_key = excluded.auth_key",
            (user_id, endpoint, p256dh, auth_key),
        )


def remove_push_subscription(user_id: int, endpoint: str) -> None:
    with _conn() as conn:
        conn.execute(
            "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
            (user_id, endpoint),
        )


def remove_push_subscription_by_endpoint(endpoint: str) -> None:
    """Used by the notify job to prune subscriptions the push service reports as gone (410)."""
    with _conn() as conn:
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
        conn.execute("DELETE FROM devices WHERE endpoint = ?", (endpoint,))


def list_push_subscriptions_with_follows() -> list[dict]:
    """One row per user who has both a push subscription and at least one
    followed topic, with all of that user's subscriptions and follows attached
    — everything push_notify.send_spike_notifications() needs in one call."""
    with _conn() as conn:
        user_ids = [
            r["user_id"] for r in conn.execute(
                "SELECT DISTINCT ps.user_id FROM push_subscriptions ps "
                "JOIN follows f ON f.user_id = ps.user_id"
            ).fetchall()
        ]
        result = []
        for uid in user_ids:
            subs = conn.execute(
                "SELECT endpoint, p256dh, auth_key FROM push_subscriptions WHERE user_id = ?",
                (uid,),
            ).fetchall()
            follows = conn.execute(
                "SELECT type, value, label FROM follows WHERE user_id = ?",
                (uid,),
            ).fetchall()
            result.append({
                "user_id": uid,
                "subscriptions": [dict(r) for r in subs],
                "follows": [dict(r) for r in follows],
            })
        return result


# The editions a reader can be notified of; also the column names, so only
# these ever reach the SQL below
NOTIFICATION_PREFS = ("daily_brief", "weekly_review")


def _migrate_notification_prefs(conn: sqlite3.Connection) -> None:
    # The table first shipped with daily_brief alone (26/10/2026)
    if "weekly_review" not in {r["name"] for r in conn.execute("PRAGMA table_info(notification_prefs)")}:
        conn.execute("ALTER TABLE notification_prefs ADD COLUMN weekly_review INTEGER NOT NULL DEFAULT 0")


def get_notification_prefs(user_id: int) -> dict:
    with _conn() as conn:
        row = conn.execute(
            f"SELECT {', '.join(NOTIFICATION_PREFS)} FROM notification_prefs WHERE user_id = ?", (user_id,)
        ).fetchone()
        return {k: bool(row and row[k]) for k in NOTIFICATION_PREFS}


def set_notification_pref(user_id: int, pref: str, on: bool) -> None:
    if pref not in NOTIFICATION_PREFS:
        raise AuthError("Réglage de notification inconnu.")
    with _conn() as conn:
        conn.execute(
            f"INSERT INTO notification_prefs (user_id, {pref}) VALUES (?, ?) "
            f"ON CONFLICT(user_id) DO UPDATE SET {pref} = excluded.{pref}",
            (user_id, int(on)),
        )


def list_subscriptions_for(pref: str) -> list[dict]:
    """Every push subscription of the readers who turned this edition on."""
    if pref not in NOTIFICATION_PREFS:
        raise AuthError("Réglage de notification inconnu.")
    with _conn() as conn:
        rows = conn.execute(
            "SELECT ps.endpoint, ps.p256dh, ps.auth_key FROM push_subscriptions ps "
            f"JOIN notification_prefs np ON np.user_id = ps.user_id WHERE np.{pref} = 1"
        ).fetchall()
        return [dict(r) for r in rows]


# ── Devices (no account needed) ─────────────────────────────────────────────

# The general notifications a device can take; also the column names, so only
# these ever reach the SQL below
DEVICE_PREFS = ("morning", "wave", "alerts")


def _migrate_devices(conn: sqlite3.Connection) -> None:
    # Once (schema version 1, 30/10/2026): devices that subscribed through an
    # account before the devices table existed take the general notifications too
    if conn.execute("PRAGMA user_version").fetchone()[0] >= 1:
        return
    conn.execute(
        "INSERT OR IGNORE INTO devices (endpoint, p256dh, auth_key) "
        "SELECT endpoint, p256dh, auth_key FROM push_subscriptions"
    )
    conn.execute("PRAGMA user_version = 1")


def _device_prefs(row: sqlite3.Row | None) -> dict | None:
    return {k: bool(row[k]) for k in DEVICE_PREFS} if row else None


def register_device(endpoint: str, p256dh: str, auth_key: str) -> dict:
    """Add a device, or refresh its keys and last visit; its choices are kept."""
    with _conn() as conn:
        conn.execute(
            "INSERT INTO devices (endpoint, p256dh, auth_key) VALUES (?, ?, ?) "
            "ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, "
            "auth_key = excluded.auth_key, seen_at = datetime('now')",
            (endpoint, p256dh, auth_key),
        )
        row = conn.execute(f"SELECT {', '.join(DEVICE_PREFS)} FROM devices WHERE endpoint = ?", (endpoint,)).fetchone()
        return _device_prefs(row)


def get_device_prefs(endpoint: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute(f"SELECT {', '.join(DEVICE_PREFS)} FROM devices WHERE endpoint = ?", (endpoint,)).fetchone()
        return _device_prefs(row)


def set_device_pref(endpoint: str, pref: str, on: bool) -> None:
    if pref not in DEVICE_PREFS:
        raise AuthError("Réglage de notification inconnu.")
    with _conn() as conn:
        conn.execute(f"UPDATE devices SET {pref} = ? WHERE endpoint = ?", (int(on), endpoint))


def remove_device(endpoint: str) -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM devices WHERE endpoint = ?", (endpoint,))


def first_name(display_name: str | None) -> str:
    """How a notification greets a reader: the first word of their display name
    ("Vhiny MOMBO" → "Vhiny"), nothing when it looks like an address."""
    word = (display_name or "").strip().split(" ")[0].strip(" ,.;:")
    if "@" in word:
        return ""
    if word.isupper() and len(word) > 1:
        word = word.capitalize()
    return (word[:1].upper() + word[1:])[:30]


def list_devices_for(pref: str) -> list[dict]:
    """Every device that takes this general notification, with the first name of
    the account it was turned on from (empty for a device without an account)."""
    if pref not in DEVICE_PREFS:
        raise AuthError("Réglage de notification inconnu.")
    with _conn() as conn:
        rows = conn.execute(
            f"SELECT d.endpoint, d.p256dh, d.auth_key, u.display_name FROM devices d "
            f"LEFT JOIN push_subscriptions ps ON ps.endpoint = d.endpoint "
            f"LEFT JOIN users u ON u.id = ps.user_id WHERE d.{pref} = 1"
        ).fetchall()
        return [{**dict(r), "first_name": first_name(r["display_name"])} for r in rows]


def count_devices() -> dict:
    with _conn() as conn:
        row = conn.execute(
            f"SELECT COUNT(*) AS total, {', '.join(f'SUM({p}) AS {p}' for p in DEVICE_PREFS)} FROM devices"
        ).fetchone()
        return {k: row[k] or 0 for k in ("total", *DEVICE_PREFS)}


def list_user_subscriptions(user_id: int) -> list[dict]:
    """The devices of one reader (an announcement's test goes to the sender alone)."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT ps.endpoint, ps.p256dh, ps.auth_key, u.display_name FROM push_subscriptions ps "
            "JOIN users u ON u.id = ps.user_id WHERE ps.user_id = ?", (user_id,)
        ).fetchall()
        return [{**dict(r), "first_name": first_name(r["display_name"])} for r in rows]


def log_notification(kind: str, day: str, keys: list[str], title: str, sent: int) -> None:
    with _conn() as conn:
        conn.execute(
            "INSERT INTO notification_log (kind, day, keys, title, sent) VALUES (?, ?, ?, ?, ?)",
            (kind, day, "\n".join(keys), title, sent),
        )


def notifications_sent(kind: str, since_day: str) -> list[dict]:
    """Sends of one kind from a day on, newest first."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM notification_log WHERE kind = ? AND day >= ? ORDER BY id DESC", (kind, since_day)
        ).fetchall()
        return [dict(r) for r in rows]


# ── Assistant conversations (per user) ──────────────────────────────────────

MAX_CONVERSATIONS = 100


def list_conversations(user_id: int, limit: int = 30) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, corpus, title, json_array_length(turns) AS turns, updated_at "
            "FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def get_conversation(user_id: int, conv_id: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT id, corpus, title, turns, updated_at FROM conversations WHERE user_id = ? AND id = ?",
            (user_id, conv_id),
        ).fetchone()
        if not row:
            return None
        return {**dict(row), "turns": json.loads(row["turns"])}


def save_conversation(user_id: int, conv_id: str, corpus: str, turns: list[dict]) -> None:
    """Create or replace a conversation; the oldest beyond MAX_CONVERSATIONS are dropped."""
    title = turns[0]["question"].strip()[:120]
    with _conn() as conn:
        conn.execute(
            "INSERT INTO conversations (id, user_id, corpus, title, turns) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(user_id, id) DO UPDATE SET corpus = excluded.corpus, title = excluded.title, "
            "turns = excluded.turns, updated_at = datetime('now')",
            (conv_id, user_id, corpus, title, json.dumps(turns, ensure_ascii=False)),
        )
        conn.execute(
            "DELETE FROM conversations WHERE user_id = ? AND id NOT IN "
            "(SELECT id FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?)",
            (user_id, user_id, MAX_CONVERSATIONS),
        )


def delete_conversation(user_id: int, conv_id: str) -> None:
    with _conn() as conn:
        conn.execute("DELETE FROM conversations WHERE user_id = ? AND id = ?", (user_id, conv_id))


# ── Password reset by e-mail ────────────────────────────────────────────────

RESET_TTL_MINUTES = 60


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_password_reset(email: str) -> tuple[dict, str] | None:
    """A one-hour, single-use reset token for this address, or None when no
    account uses it. Only the token's hash is stored: a leaked database copy
    cannot be used to reset anyone's password."""
    email = email.strip().lower()
    with _conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not row:
            return None
        token = secrets.token_urlsafe(32)
        expires_at = (datetime.utcnow() + timedelta(minutes=RESET_TTL_MINUTES)).isoformat()
        conn.execute(
            "INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (_hash_token(token), row["id"], expires_at),
        )
        return _public_user(row), token


def reset_password(token: str, new_password: str) -> tuple[dict, str]:
    """Set a new password from a reset link; every other session is signed out."""
    if len(new_password) < 8:
        raise AuthError("Le mot de passe doit contenir au moins 8 caractères.")
    with _conn() as conn:
        reset = conn.execute(
            "SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > ?",
            (_hash_token(token), datetime.utcnow().isoformat()),
        ).fetchone()
        if not reset:
            raise AuthError("Ce lien n'est plus valable. Demandez-en un nouveau.")
        new_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
        owner = conn.execute("SELECT email_verified_at FROM users WHERE id = ?", (reset["user_id"],)).fetchone()
        if not owner["email_verified_at"]:
            # The mailbox's owner takes over an account opened on their address without
            # proof: a Facebook identity that came with it must not keep its way in
            conn.execute("DELETE FROM identities WHERE user_id = ?", (reset["user_id"],))
        conn.execute("UPDATE users SET password_hash = ?, email_verified_at = datetime('now') WHERE id = ?",
                     (new_hash, reset["user_id"]))
        conn.execute("UPDATE password_resets SET used = 1 WHERE user_id = ?", (reset["user_id"],))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (reset["user_id"],))
        row = conn.execute("SELECT * FROM users WHERE id = ?", (reset["user_id"],)).fetchone()
        return _public_user(row), _create_session(conn, row["id"])


# ── Sign-in with Google or Facebook (see oauth.py) ──────────────────────────

OAUTH_STATE_TTL_MINUTES = 10
LOGIN_CODE_TTL_SECONDS = 120
APP_CODE_ATTEMPTS = 5


def _migrate_oauth_states(conn: sqlite3.Connection) -> None:
    if "app_hash" not in {r["name"] for r in conn.execute("PRAGMA table_info(oauth_states)")}:
        conn.execute("ALTER TABLE oauth_states ADD COLUMN app_hash TEXT")
    if "browser_hash" not in {r["name"] for r in conn.execute("PRAGMA table_info(oauth_states)")}:
        conn.execute("ALTER TABLE oauth_states ADD COLUMN browser_hash TEXT")


def create_oauth_state(provider: str, app_secret: str | None = None, browser_secret: str | None = None) -> str:
    """A single-use value sent to the provider and checked on the way back. In a
    browser it is tied to browser_secret (a cookie): a callback this browser did not
    start is refused (CSRF). With app_secret, the installed app that holds it will
    collect the result, against a code (see finish_app_login)."""
    state = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    expires = (now + timedelta(minutes=OAUTH_STATE_TTL_MINUTES)).isoformat()
    with _conn() as conn:
        _migrate_oauth_states(conn)
        conn.execute("DELETE FROM oauth_states WHERE expires_at < ?", (now.isoformat(),))
        conn.execute("DELETE FROM app_logins WHERE expires_at < ?", (now.isoformat(),))
        app_hash = _hash_token(app_secret) if app_secret else None
        conn.execute(
            "INSERT INTO oauth_states (state_hash, provider, expires_at, app_hash, browser_hash) VALUES (?, ?, ?, ?, ?)",
            (_hash_token(state), provider, expires, app_hash, _hash_token(browser_secret) if browser_secret else None),
        )
        if app_hash:
            conn.execute(
                "INSERT OR REPLACE INTO app_logins (app_hash, user_id, error, expires_at) VALUES (?, NULL, NULL, ?)",
                (app_hash, expires),
            )
    return state


def consume_oauth_state(state: str, provider: str, browser_secret: str | None = None) -> tuple[bool, str | None]:
    """(valid, app_hash): app_hash is set when an installed app waits for this sign-in."""
    with _conn() as conn:
        _migrate_oauth_states(conn)
        row = conn.execute(
            "SELECT app_hash, browser_hash FROM oauth_states WHERE state_hash = ? AND provider = ? AND expires_at > ?",
            (_hash_token(state or ""), provider, datetime.utcnow().isoformat()),
        ).fetchone()
        if not row:
            return False, None
        if row["browser_hash"] and not hmac.compare_digest(row["browser_hash"], _hash_token(browser_secret or "")):
            return False, None      # another browser than the one that started: left for the right one
        conn.execute("DELETE FROM oauth_states WHERE state_hash = ?", (_hash_token(state),))
        return True, row["app_hash"]


def finish_app_login(app_hash: str, user_id: int | None = None, error: str | None = None) -> str | None:
    """Record how the sheet's sign-in ended. On success returns the code to show there,
    and only there: it never travels to whoever holds the secret."""
    code = f"{secrets.randbelow(1_000_000):06d}" if user_id is not None else None
    expires = (datetime.utcnow() + timedelta(minutes=OAUTH_STATE_TTL_MINUTES)).isoformat()   # time to go back and type it
    with _conn() as conn:
        conn.execute(
            "UPDATE app_logins SET user_id = ?, error = ?, code_hash = ?, attempts = 0, expires_at = ? WHERE app_hash = ?",
            (user_id, error, _hash_token(f"{app_hash}:{code}") if code else None, expires, app_hash),
        )
    return code


def app_login_result(app_secret: str) -> dict:
    """What the waiting app sees: pending, then that a code is expected, or the error.
    Holding the secret is never enough for a session (see confirm_app_login)."""
    app_hash = _hash_token(app_secret)
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM app_logins WHERE app_hash = ? AND expires_at > ?", (app_hash, datetime.utcnow().isoformat()),
        ).fetchone()
        if not row:
            return {"status": "expired"}
        if row["error"]:
            conn.execute("DELETE FROM app_logins WHERE app_hash = ?", (app_hash,))
            return {"status": "error", "message": row["error"]}
        return {"status": "pending" if row["user_id"] is None else "confirm"}


def confirm_app_login(app_secret: str, code: str) -> dict:
    """The secret and the code together: one session, once. A few wrong codes end the attempt."""
    app_hash = _hash_token(app_secret)
    code = re.sub(r"\D", "", code)          # "482 913" as shown on screen
    with _conn() as conn:
        row = conn.execute(
            "SELECT * FROM app_logins WHERE app_hash = ? AND expires_at > ? AND user_id IS NOT NULL",
            (app_hash, datetime.utcnow().isoformat()),
        ).fetchone()
        if not row or not row["code_hash"]:
            return {"status": "expired"}
        if not hmac.compare_digest(row["code_hash"], _hash_token(f"{app_hash}:{code}")):
            if row["attempts"] + 1 >= APP_CODE_ATTEMPTS:
                conn.execute("DELETE FROM app_logins WHERE app_hash = ?", (app_hash,))
                return {"status": "expired"}
            conn.execute("UPDATE app_logins SET attempts = attempts + 1 WHERE app_hash = ?", (app_hash,))
            return {"status": "wrong"}
        conn.execute("DELETE FROM app_logins WHERE app_hash = ?", (app_hash,))
        user = conn.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
        return {"status": "ok", "user": _public_user(user), "token": _create_session(conn, user["id"])}


def _hand_to_proven_owner(conn: sqlite3.Connection, user_id: int) -> None:
    """The address's proven owner arrives on an account never proven: every other
    way in stops working (password, sessions, identities, Clerk account, devices)."""
    unusable = bcrypt.hashpw(secrets.token_bytes(32), bcrypt.gensalt()).decode()
    conn.execute("UPDATE users SET password_hash = ?, email_verified_at = datetime('now'), "
                 "clerk_user_id = NULL WHERE id = ?", (unusable, user_id))
    conn.execute("DELETE FROM devices WHERE endpoint IN "
                 "(SELECT endpoint FROM push_subscriptions WHERE user_id = ?)", (user_id,))
    for table in ("sessions", "password_resets", "login_codes", "app_logins", "identities", "push_subscriptions"):
        conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))


def login_with_clerk(clerk_user: dict) -> tuple[dict, str]:
    """The account for a reader Clerk has signed in, and a session on it.

    Found by its Clerk account; else by the account number set at the import
    (scripts/clerk_import.py), which only this server writes; else by address,
    only when Clerk has proven it, with the same care as for Google; else a new
    account. An address Clerk has not proven is never trusted here."""
    clerk_id = clerk_user["id"]
    email = clerk_user.get("email") or ""
    verified = bool(clerk_user.get("email_verified")) and bool(_EMAIL_RE.match(email))
    external = clerk_user.get("external_id") or ""
    with _conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE clerk_user_id = ?", (clerk_id,)).fetchone()
        if not row and external.isdigit():
            row = conn.execute("SELECT * FROM users WHERE id = ? AND clerk_user_id IS NULL",
                               (int(external),)).fetchone()
        if not row and verified:
            row = conn.execute("SELECT * FROM users WHERE email = ? AND clerk_user_id IS NULL", (email,)).fetchone()
            if row and not row["email_verified_at"]:
                _hand_to_proven_owner(conn, row["id"])
        if row:
            user_id = row["id"]
            conn.execute("UPDATE users SET clerk_user_id = ? WHERE id = ?", (clerk_id, user_id))
            if verified and row["email"] == email and not row["email_verified_at"]:
                conn.execute("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?", (user_id,))
        else:
            if not verified:
                raise AuthError("Confirmez d'abord votre adresse e-mail.")
            if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
                # Already tied to another Clerk account: never two accounts on one address
                raise AuthError("Un compte existe déjà avec cette adresse e-mail.")
            name = (clerk_user.get("name") or "").strip()[:80] or email.split("@")[0]
            unusable = bcrypt.hashpw(secrets.token_bytes(32), bcrypt.gensalt()).decode()
            user_id = conn.execute(
                "INSERT INTO users (email, password_hash, display_name, email_verified_at, clerk_user_id) "
                "VALUES (?, ?, ?, datetime('now'), ?)", (email, unusable, name, clerk_id),
            ).lastrowid
        user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return _public_user(user), _create_session(conn, user_id)


def clerk_user_id(user_id: int) -> str | None:
    with _conn() as conn:
        row = conn.execute("SELECT clerk_user_id FROM users WHERE id = ?", (user_id,)).fetchone()
        return row["clerk_user_id"] if row else None


def users_for_clerk_import() -> list[dict]:
    """Accounts not yet in Clerk, with what the import sends (scripts/clerk_import.py)."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, email, password_hash, display_name, created_at, email_verified_at FROM users "
            "WHERE clerk_user_id IS NULL ORDER BY id").fetchall()
        return [dict(r) for r in rows]


def set_clerk_user_id(user_id: int, clerk_id: str) -> None:
    with _conn() as conn:
        conn.execute("UPDATE users SET clerk_user_id = ? WHERE id = ?", (clerk_id, user_id))


def login_with_identity(provider: str, ident: dict) -> int:
    """The account for this Google or Facebook identity: the one already linked,
    else an existing account with the same Google-verified address, else a new one.

    Anyone can open an account on someone else's address, since signing up proves
    nothing. So when the address's proven owner arrives on an account never proven,
    every other way in stops working: password, sessions, other identities, devices.
    The owner gets a password back through "Mot de passe oublié", which mails them."""
    subject = ident["subject"]
    email = (ident.get("email") or "").strip().lower() or None
    verified = bool(ident.get("email_verified"))
    with _conn() as conn:
        row = conn.execute(
            "SELECT user_id FROM identities WHERE provider = ? AND subject = ?", (provider, subject),
        ).fetchone()
        if row:
            return row["user_id"]
        existing = conn.execute("SELECT id, email_verified_at FROM users WHERE email = ?", (email,)).fetchone() if email else None
        if existing:
            # Linking by address is safe only when the provider vouches for it
            if not verified:
                raise AuthError(
                    "Un compte existe déjà avec l'adresse de ce compte Facebook. "
                    "Connectez-vous avec votre e-mail et votre mot de passe."
                )
            user_id = existing["id"]
            if not existing["email_verified_at"]:
                _hand_to_proven_owner(conn, user_id)
        else:
            address = email if email and _EMAIL_RE.match(email) else f"{provider}-{subject}@{NO_EMAIL_DOMAIN}"
            name = (ident.get("name") or "").strip()[:80] or (email.split("@")[0] if email else "Lecteur")
            # No password: a random one nobody knows. "Mot de passe oublié" sets a real one
            unusable = bcrypt.hashpw(secrets.token_bytes(32), bcrypt.gensalt()).decode()
            user_id = conn.execute(
                "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES (?, ?, ?, ?)",
                (address, unusable, name, datetime.utcnow().isoformat() if verified and address == email else None),
            ).lastrowid
        conn.execute(
            "INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)", (provider, subject, user_id),
        )
        return user_id


def create_login_code(user_id: int) -> str:
    """A two-minute, single-use code the app trades for a session: the session
    token itself never travels in an address."""
    code = secrets.token_urlsafe(32)
    now = datetime.utcnow()
    with _conn() as conn:
        conn.execute("DELETE FROM login_codes WHERE expires_at < ?", (now.isoformat(),))
        conn.execute(
            "INSERT INTO login_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (_hash_token(code), user_id, (now + timedelta(seconds=LOGIN_CODE_TTL_SECONDS)).isoformat()),
        )
    return code


def exchange_login_code(code: str) -> tuple[dict, str]:
    with _conn() as conn:
        row = conn.execute(
            "SELECT user_id FROM login_codes WHERE code_hash = ? AND expires_at > ?",
            (_hash_token(code), datetime.utcnow().isoformat()),
        ).fetchone()
        if not row:
            raise AuthError("La connexion a expiré. Recommencez.")
        conn.execute("DELETE FROM login_codes WHERE code_hash = ?", (_hash_token(code),))
        user = conn.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
        return _public_user(user), _create_session(conn, user["id"])


def delete_user(user_id: int) -> None:
    """Erase the account and everything attached to it, at the reader's request."""
    with _conn() as conn:
        # The reader's devices stop receiving the general notifications too
        conn.execute("DELETE FROM devices WHERE endpoint IN "
                     "(SELECT endpoint FROM push_subscriptions WHERE user_id = ?)", (user_id,))
        for table in ("sessions", "follows", "push_subscriptions", "notification_prefs", "password_resets",
                      "conversations", "identities", "login_codes", "app_logins"):
            conn.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))
        # Ideas already sent stay, without who sent them
        conn.execute("UPDATE suggestions SET user_id = NULL, contact = '' WHERE user_id = ?", (user_id,))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


def create_share(corpus: str, question: str, headline: str, answer: str, sources: list[dict]) -> str:
    """Keep a shared answer under a new short id, and return the id."""
    with _conn() as conn:
        while True:
            share_id = secrets.token_urlsafe(6)
            try:
                conn.execute(
                    "INSERT INTO shares (id, corpus, question, headline, answer, sources) VALUES (?, ?, ?, ?, ?, ?)",
                    (share_id, corpus, question, headline, answer, json.dumps(sources, ensure_ascii=False)),
                )
                return share_id
            except sqlite3.IntegrityError:
                continue    # the same id twice: draw another


def get_share(share_id: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute(
            "SELECT corpus, question, headline, answer, sources, created_at FROM shares WHERE id = ?", (share_id,)
        ).fetchone()
    if not row:
        return None
    return {**dict(row), "sources": json.loads(row["sources"])}


SUGGESTION_STATUSES = ("nouvelle", "retenue", "faite", "ecartee")


def add_suggestion(user_id: int | None, kind: str, message: str, contact: str, page: str) -> int:
    with _conn() as conn:
        cur = conn.execute(
            "INSERT INTO suggestions (user_id, kind, message, contact, page) VALUES (?, ?, ?, ?, ?)",
            (user_id, kind, message, contact, page),
        )
        return cur.lastrowid


def list_suggestions(limit: int = 300) -> list[dict]:
    """Newest first, with the sender's name and e-mail when they had an account."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT s.id, s.kind, s.message, s.contact, s.page, s.status, s.created_at, "
            "u.display_name AS user_name, u.email AS user_email "
            "FROM suggestions s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        if d["user_email"] and d["user_email"].endswith("@" + NO_EMAIL_DOMAIN):
            d["user_email"] = None
        out.append(d)
    return out


def set_suggestion_status(suggestion_id: int, status: str) -> bool:
    with _conn() as conn:
        cur = conn.execute("UPDATE suggestions SET status = ? WHERE id = ?", (status, suggestion_id))
        return cur.rowcount > 0
