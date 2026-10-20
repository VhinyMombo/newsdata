"""auth.py — user accounts, sessions, and per-user followed topics.

SQLite-backed, same pattern as report_archive.py: no new service, no new
pip dependency beyond bcrypt (already installed for something else in this
env — check before adding it elsewhere). Sessions are opaque random tokens
in a table, not JWTs — a DB row you can delete is a real logout; a stateless
JWT isn't, without a blocklist that's just this table by another name.
"""

from __future__ import annotations

import os
import re
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
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
        yield conn
        conn.commit()
    finally:
        conn.close()


def _public_user(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "email": row["email"], "display_name": row["display_name"]}


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
