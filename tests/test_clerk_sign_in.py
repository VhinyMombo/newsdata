"""Sign-in through Clerk, offline: tokens signed with a key made for the test, Clerk's
answers simulated, accounts in a temporary database.
Run: .venv/bin/python tests/test_clerk_sign_in.py"""
import base64
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ["AUTH_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "auth.db")
HOST = "test-kiosque.clerk.accounts.dev"
os.environ["CLERK_PUBLISHABLE_KEY"] = "pk_test_" + base64.b64encode(f"{HOST}$".encode()).decode().rstrip("=")
os.environ["CLERK_SECRET_KEY"] = "sk_test_simule"
os.environ["CLERK_AUTHORIZED_PARTIES"] = "https://staging.lekiosque.hodologic.fr"
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

import jwt  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402

import auth  # noqa: E402
import clerk_auth  # noqa: E402
import clerk_import  # noqa: E402

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
clerk_auth._signing_key = lambda token: KEY.public_key()


def token(key=KEY, **over):
    now = int(time.time())
    claims = {"sub": "user_1", "iss": f"https://{HOST}", "azp": "https://staging.lekiosque.hodologic.fr",
              "iat": now, "nbf": now, "exp": now + 60, **over}
    return jwt.encode(claims, key, algorithm="RS256")


def refused(tok):
    try:
        clerk_auth.verify_session_token(tok)
    except clerk_auth.ClerkError:
        return True
    return False


def test_host_from_key():
    assert clerk_auth.frontend_host() == HOST


def test_tokens():
    assert clerk_auth.verify_session_token(token())["sub"] == "user_1"
    assert refused(token(exp=int(time.time()) - 60)), "expired"
    assert refused(token(azp="https://autre-site.example")), "other origin"
    assert refused(token(azp=None)), "no origin"
    assert refused(token(iss="https://autre.clerk.accounts.dev")), "other instance"
    assert refused(token(key=OTHER_KEY)), "not signed by the instance"
    assert refused("pas-un-jeton")


def clerk_user(cid, email, verified=True, external=""):
    return {"id": cid, "email": email, "email_verified": verified, "name": "Lecteur", "external_id": external}


def row(user_id):
    with auth._conn() as conn:
        return dict(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())


def test_linking():
    # An account here, imported: found again by its number even with an address not proven
    imported, _ = auth.create_user("importe@example.invalid", "motdepasse1", "Importé")
    user, tok = auth.login_with_clerk(clerk_user("user_a", "importe@example.invalid", verified=False,
                                                 external=str(imported["id"])))
    assert user["id"] == imported["id"] and not user["email_verified"] and tok
    assert row(imported["id"])["clerk_user_id"] == "user_a"
    # Next time, by its Clerk account
    assert auth.login_with_clerk(clerk_user("user_a", "importe@example.invalid", verified=False))[0]["id"] == imported["id"]

    # Someone opened an account here on another's address; its proven owner arrives
    squat, squat_token = auth.create_user("proprio@example.invalid", "motdepasse2", "Squat")
    owner, _ = auth.login_with_clerk(clerk_user("user_b", "proprio@example.invalid"))
    assert owner["id"] == squat["id"] and owner["email_verified"]
    assert auth.get_user_by_token(squat_token) is None, "earlier sessions must stop"
    try:
        auth.authenticate("proprio@example.invalid", "motdepasse2")
        raise AssertionError("the old password must stop working")
    except auth.AuthError:
        pass

    # An address Clerk has not proven is never used to find an account
    other, _ = auth.create_user("autre@example.invalid", "motdepasse3", "Autre")
    try:
        auth.login_with_clerk(clerk_user("user_c", "autre@example.invalid", verified=False))
        raise AssertionError("an unproven address must not open a session")
    except auth.AuthError:
        pass
    assert row(other["id"])["clerk_user_id"] is None

    # A new reader: a new account, proven
    new, _ = auth.login_with_clerk(clerk_user("user_d", "nouveau@example.invalid"))
    assert new["email_verified"] and row(new["id"])["clerk_user_id"] == "user_d"

    # The account number only counts for an account not yet in Clerk
    try:
        auth.login_with_clerk(clerk_user("user_e", "x@example.invalid", verified=False, external=str(imported["id"])))
        raise AssertionError("an account already in Clerk must not be taken by its number")
    except auth.AuthError:
        pass


def test_import_body():
    users = {u["id"]: u for u in auth.users_for_clerk_import()}
    u = users[next(iter(users))]
    body = clerk_import.body_for(u)
    assert body["password_hasher"] == "bcrypt" and body["password_digest"].startswith("$2b$")
    assert body["external_id"] == str(u["id"])
    assert body["email_address_identification_status"] == ["verified" if u["email_verified_at"] else "reserved"]
    assert body["created_at"].endswith("Z") and "T" in body["created_at"]


def test_user_exists():
    # Only Clerk's own « not found » counts as deleted: an error or no answer never does,
    # or a Clerk outage would erase the accounts of everyone whose session ended
    class Res:
        def __init__(self, code): self.status_code = code
    real = clerk_auth._call
    try:
        for code, expected in ((200, True), (404, False), (500, None), (401, None), (429, None)):
            clerk_auth._call = lambda *a, code=code, **k: Res(code)
            assert clerk_auth.user_exists("user_x") is expected, code

        def down(*a, **k):
            raise clerk_auth.requests.ConnectionError("down")
        clerk_auth._call = down
        assert clerk_auth.user_exists("user_x") is None
    finally:
        clerk_auth._call = real


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"{name}: ok")
