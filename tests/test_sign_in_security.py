"""Sign-in regressions from the 2026-11-08 audit (K-01, K-02), on a throwaway database,
with the provider simulated. Run: AUTH_DB_PATH=/tmp/x.db .venv/bin/python tests/test_sign_in_security.py"""
import os
import re
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

os.environ["AUTH_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "auth.db")
os.environ["ADMIN_EMAILS"] = "chef@example.invalid"
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

import api  # noqa: E402
import auth  # noqa: E402
import oauth  # noqa: E402

PUBLIC = api.PUBLIC_URL


def google(subject, email):
    return {"subject": subject, "email": email, "email_verified": True, "name": "Vrai titulaire"}


def client():
    return TestClient(api.app, base_url=PUBLIC, follow_redirects=False)


def sign_in_sheet(c, secret, ident):
    """Start from a link carrying `secret`, finish at the provider, in browser `c`."""
    with patch.object(oauth, "configured", return_value=["google"]), \
         patch.object(oauth, "authorize_url", side_effect=lambda p, r, s: f"https://provider.invalid/?state={s}"), \
         patch.object(oauth, "identity", return_value=ident):
        start = c.get(f"/auth/google/start?app={secret}")
        assert start.status_code == 303 and "kiosque_oauth" not in start.cookies
        state = start.headers["location"].split("state=")[1]
        return c.get(f"/auth/google/callback?code=x&state={state}")


def test_sent_link_secret_alone_gives_no_session():
    secret = "secret-choisi-par-l-expediteur-du-lien"
    page = sign_in_sheet(client(), secret, google("g-1", "lecteur1@example.invalid")).text
    attacker = client()
    poll = attacker.get(f"/auth/app-wait?app={secret}").json()
    assert poll == {"status": "confirm"}, poll                # no token, no user
    code = re.search(r"code: '(\d{6})'", page).group(1)
    wrong = "000000" if code != "000000" else "111111"
    assert attacker.post("/auth/app-confirm", json={"app": secret, "code": wrong}).json() == {"status": "wrong"}
    # The person who signed in, typing what the page shows, spaces included
    ok = client().post("/auth/app-confirm", json={"app": secret, "code": f"{code[:3]} {code[3:]}"}).json()
    assert ok["status"] == "ok" and auth.get_user_by_token(ok["token"])["email"] == "lecteur1@example.invalid"
    assert attacker.post("/auth/app-confirm", json={"app": secret, "code": code}).json() == {"status": "expired"}


def test_guessing_the_code_ends_the_attempt():
    secret = "secret-pour-essais-repetes-du-code-1234"
    page = sign_in_sheet(client(), secret, google("g-2", "lecteur2@example.invalid")).text
    code = re.search(r"code: '(\d{6})'", page).group(1)
    wrong = "000000" if code != "000000" else "111111"
    answers = [auth.confirm_app_login(secret, wrong)["status"] for _ in range(auth.APP_CODE_ATTEMPTS)]
    assert answers == ["wrong"] * (auth.APP_CODE_ATTEMPTS - 1) + ["expired"], answers
    assert auth.confirm_app_login(secret, code)["status"] == "expired"


def test_browser_flow_is_tied_to_the_browser_that_started():
    with patch.object(oauth, "configured", return_value=["google"]), \
         patch.object(oauth, "authorize_url", side_effect=lambda p, r, s: f"https://provider.invalid/?state={s}"), \
         patch.object(oauth, "identity", return_value=google("g-3", "attaquant@example.invalid")):
        started = client()
        start = started.get("/auth/google/start")
        state = start.headers["location"].split("state=")[1]
        cookie = start.headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=lax" in cookie
        # The callback handed to someone else's browser signs nobody in
        other = client().get(f"/auth/google/callback?code=x&state={state}")
        assert "erreur=expire" in other.headers["location"]
        # and did not burn the attempt of the browser that started
        back = started.get(f"/auth/google/callback?code=x&state={state}")
        assert "code=" in back.headers["location"]


def test_proven_owner_shuts_out_who_opened_the_account_on_their_address():
    email = "futur@example.invalid"
    user, squatter = auth.create_user(email, "MotDePasseDuTiers-1", "Tiers")
    assert auth.login_with_identity("google", google("g-4", email)) == user["id"]
    assert auth.get_user_by_token(squatter) is None
    try:
        auth.authenticate(email, "MotDePasseDuTiers-1")
        raise AssertionError("old password still works")
    except auth.AuthError:
        pass
    assert auth.get_user_by_token(auth.exchange_login_code(auth.create_login_code(user["id"]))[1])["email_verified"]


def test_facebook_identity_on_a_claimed_address_loses_its_way_in():
    email = "fb@example.invalid"
    fb = {"subject": "f-1", "email": email, "email_verified": False, "name": "Tiers"}
    first = auth.login_with_identity("facebook", fb)
    assert auth.login_with_identity("google", google("g-5", email)) == first
    assert auth.login_with_identity("facebook", {**fb, "subject": "f-2", "email": None}) != first
    try:
        auth.login_with_identity("facebook", {**fb, "subject": "f-3"})
        raise AssertionError("unverified address linked")
    except auth.AuthError:
        pass
    assert auth.login_with_identity("google", google("g-5", email)) == first
    with auth._conn() as conn:
        assert not conn.execute("SELECT 1 FROM identities WHERE subject = 'f-1'").fetchone()


def test_a_verified_account_keeps_its_password_when_google_arrives():
    email = "prouve@example.invalid"
    user, session = auth.create_user(email, "MotDePasse-Prouve-1", "Prouvé")
    with auth._conn() as conn:
        conn.execute("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?", (user["id"],))
    assert auth.login_with_identity("google", google("g-6", email)) == user["id"]
    assert auth.get_user_by_token(session) is not None
    assert auth.authenticate(email, "MotDePasse-Prouve-1")[0]["id"] == user["id"]


def test_reset_link_proves_the_address_and_removes_a_facebook_way_in():
    email = "reset@example.invalid"
    uid = auth.login_with_identity("facebook", {"subject": "f-9", "email": email, "email_verified": False, "name": "T"})
    user, token = auth.create_password_reset(email)
    assert auth.reset_password(token, "NouveauMotDePasse-1")[0]["email_verified"]
    with auth._conn() as conn:
        assert not conn.execute("SELECT 1 FROM identities WHERE user_id = ?", (uid,)).fetchone()


def test_admin_needs_a_proven_address():
    admin, _ = auth.create_user("chef@example.invalid", "MotDePasseChef-1", "Chef")
    assert api.is_admin(admin) is False
    user, token = auth.create_password_reset("chef@example.invalid")
    assert api.is_admin(auth.reset_password(token, "MotDePasseChef-2")[0]) is True


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok ", t.__name__)
    print(f"{len(tests)} tests ok")
