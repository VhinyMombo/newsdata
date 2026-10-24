"""oauth.py — "Continuer avec Google / Facebook" by the authorization-code flow.

The browser leaves for the provider's own page and comes back to
/auth/{provider}/callback; the code is exchanged here, server to server, so no
provider SDK or tracker loads in the app and the client secret never leaves the
server. Standard library only, like mailer.py.

Configured from the environment (.env.docker on the server):
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
    FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
A provider without both values is simply not offered.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.parse
import urllib.request

FACEBOOK_GRAPH = os.getenv("FACEBOOK_GRAPH_VERSION", "v23.0")


class OAuthError(Exception):
    """The provider refused or answered something unusable."""


def _creds(provider: str) -> tuple[str, str]:
    if provider == "google":
        return os.getenv("GOOGLE_CLIENT_ID", ""), os.getenv("GOOGLE_CLIENT_SECRET", "")
    if provider == "facebook":
        return os.getenv("FACEBOOK_APP_ID", ""), os.getenv("FACEBOOK_APP_SECRET", "")
    return "", ""


def configured() -> list[str]:
    return [p for p in ("google", "facebook") if all(_creds(p))]


def authorize_url(provider: str, redirect_uri: str, state: str) -> str:
    client_id, _ = _creds(provider)
    if provider == "google":
        return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
            "client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
            "scope": "openid email profile", "state": state, "prompt": "select_account",
        })
    return f"https://www.facebook.com/{FACEBOOK_GRAPH}/dialog/oauth?" + urllib.parse.urlencode({
        "client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
        "scope": "public_profile,email", "state": state,
    })


def _fetch_json(url: str, data: dict | None = None) -> dict:
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as e:
        raise OAuthError(f"{e.code} {e.read()[:300]!r}") from e
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise OAuthError(str(e)) from e


def identity(provider: str, code: str, redirect_uri: str) -> dict:
    """Exchange the code for who the reader is:
    {"subject", "email" (or None), "email_verified", "name"}."""
    client_id, secret = _creds(provider)
    if provider == "google":
        tokens = _fetch_json("https://oauth2.googleapis.com/token", {
            "code": code, "client_id": client_id, "client_secret": secret,
            "redirect_uri": redirect_uri, "grant_type": "authorization_code",
        })
        # Received straight from Google's token endpoint over TLS, so the ID token
        # needs no signature check (OpenID Connect Core 3.1.3.7); its claims still do
        try:
            payload = tokens["id_token"].split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        except (KeyError, IndexError, ValueError) as e:
            raise OAuthError("no usable id_token") from e
        if claims.get("aud") != client_id or claims.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
            raise OAuthError("id_token for another client")
        if claims.get("exp", 0) < time.time():
            raise OAuthError("id_token expired")
        return {
            "subject": str(claims["sub"]), "email": claims.get("email"),
            "email_verified": claims.get("email_verified") is True, "name": claims.get("name") or "",
        }

    tokens = _fetch_json(f"https://graph.facebook.com/{FACEBOOK_GRAPH}/oauth/access_token?" + urllib.parse.urlencode({
        "client_id": client_id, "client_secret": secret, "redirect_uri": redirect_uri, "code": code,
    }))
    access = tokens.get("access_token")
    if not access:
        raise OAuthError("no access_token")
    # appsecret_proof ties the call to this app: a token stolen elsewhere is useless here
    proof = hmac.new(secret.encode(), access.encode(), hashlib.sha256).hexdigest()
    me = _fetch_json(f"https://graph.facebook.com/{FACEBOOK_GRAPH}/me?" + urllib.parse.urlencode({
        "fields": "id,name,email", "access_token": access, "appsecret_proof": proof,
    }))
    if not me.get("id"):
        raise OAuthError("no Facebook id")
    # Many Facebook accounts are opened with a phone number and have no e-mail.
    # Facebook does not say whether an address was confirmed: never link by it.
    return {"subject": str(me["id"]), "email": me.get("email"), "email_verified": False, "name": me.get("name") or ""}
