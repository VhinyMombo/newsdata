"""Sign-in through Clerk: Clerk proves who the reader is (password, e-mail code,
Google, Apple), the API checks Clerk's session token, then hands out its own
session (auth.py) as for any other sign-in. Follows, conversations, quotas and
notifications stay on the reader's account here.

Off unless both keys are set (CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY): the
site then keeps its own sign-in."""
import base64
import logging
import os

import jwt
import requests

log = logging.getLogger("clerk_auth")

PUBLISHABLE_KEY = os.getenv("CLERK_PUBLISHABLE_KEY", "").strip()
SECRET_KEY = os.getenv("CLERK_SECRET_KEY", "").strip()
API = "https://api.clerk.com/v1"
TIMEOUT_S = 10


class ClerkError(Exception):
    """The token or the account could not be trusted; the message is for the reader."""


def enabled() -> bool:
    return bool(PUBLISHABLE_KEY and SECRET_KEY)


def frontend_host(publishable_key: str = PUBLISHABLE_KEY) -> str:
    """The instance's Frontend API host, which the publishable key carries:
    pk_test_ or pk_live_, then base64 of "<host>$"."""
    encoded = publishable_key.split("_", 2)[-1]
    host = base64.b64decode(encoded + "=" * (-len(encoded) % 4)).decode().rstrip("$")
    if not host or "/" in host or " " in host:
        raise ValueError("CLERK_PUBLISHABLE_KEY malformed")
    return host


def authorized_parties() -> set[str]:
    """Origins allowed to have asked for the token (its azp claim): the site itself.
    Without them, a token minted for another site of the same Clerk instance would pass."""
    raw = os.getenv("CLERK_AUTHORIZED_PARTIES") or os.getenv("PUBLIC_URL", "https://lekiosque.hodologic.fr")
    return {o.strip().rstrip("/") for o in raw.split(",") if o.strip()}


_jwks = None


def _signing_key(token: str):
    global _jwks
    if _jwks is None:
        _jwks = jwt.PyJWKClient(f"https://{frontend_host()}/.well-known/jwks.json",
                                cache_keys=True, lifespan=3600, timeout=TIMEOUT_S)
    return _jwks.get_signing_key_from_jwt(token).key


def verify_session_token(token: str) -> dict:
    """The claims of a valid Clerk session token, or ClerkError."""
    try:
        claims = jwt.decode(
            token, _signing_key(token), algorithms=["RS256"],
            issuer=f"https://{frontend_host()}",
            options={"require": ["exp", "iat", "sub", "iss"]}, leeway=5,
        )
    except (jwt.PyJWTError, ValueError) as e:
        log.info(f"Clerk token refused: {e}")
        raise ClerkError("La connexion a expiré. Recommencez.") from e
    azp = (claims.get("azp") or "").rstrip("/")
    if not azp or azp not in authorized_parties():
        log.warning(f"Clerk token for another origin refused: {azp!r}")
        raise ClerkError("La connexion a expiré. Recommencez.")
    return claims


def _call(method: str, path: str, **kwargs) -> requests.Response:
    return requests.request(method, f"{API}{path}", timeout=TIMEOUT_S,
                            headers={"Authorization": f"Bearer {SECRET_KEY}"}, **kwargs)


def get_user(clerk_id: str) -> dict:
    """What the API needs of a Clerk user: primary address, whether Clerk proved
    it, a display name, and the account number set when it was imported."""
    res = _call("GET", f"/users/{clerk_id}")
    if res.status_code != 200:
        log.error(f"Clerk user {clerk_id}: HTTP {res.status_code}")
        raise ClerkError("Le service de connexion n'a pas répondu. Réessayez dans un instant.")
    u = res.json()
    primary = next((e for e in u.get("email_addresses") or []
                    if e.get("id") == u.get("primary_email_address_id")), None)
    name = " ".join(p for p in (u.get("first_name"), u.get("last_name")) if p).strip()
    return {
        "id": u["id"],
        "email": (primary or {}).get("email_address", "").strip().lower(),
        "email_verified": ((primary or {}).get("verification") or {}).get("status") == "verified",
        "name": name or (u.get("username") or ""),
        "external_id": u.get("external_id") or "",
    }


def user_exists(clerk_id: str) -> bool | None:
    """True or False as Clerk says; None when Clerk could not tell (no answer, an error),
    which must never be read as « deleted »."""
    try:
        res = _call("GET", f"/users/{clerk_id}")
    except requests.RequestException as e:
        log.error(f"Clerk user {clerk_id}: {e}")
        return None
    if res.status_code == 200:
        return True
    if res.status_code == 404:
        return False
    log.error(f"Clerk user {clerk_id}: HTTP {res.status_code}")
    return None


def delete_user(clerk_id: str) -> None:
    """With the reader's account here, at their request."""
    res = _call("DELETE", f"/users/{clerk_id}")
    if res.status_code not in (200, 404):
        log.error(f"Clerk user {clerk_id} not deleted: HTTP {res.status_code}")
        raise ClerkError("Le compte n'a pas pu être supprimé. Réessayez.")


def create_user(body: dict) -> dict:
    """For the import of existing accounts (scripts/clerk_import.py)."""
    res = _call("POST", "/users", json=body)
    if res.status_code != 200:
        raise ClerkError(f"HTTP {res.status_code}: {res.text[:300]}")
    return res.json()
