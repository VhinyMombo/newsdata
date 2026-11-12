"""Copy the Kiosque's existing accounts into Clerk, once, before switching sign-in.

Each account keeps its password (sent as its bcrypt hash, which Clerk accepts) and
its account number (Clerk's external_id), which links it back here at its first
sign-in through Clerk (auth.login_with_clerk). An address never proven here goes
in "reserved": usable to sign in, locked against anyone else, not marked verified.

Shows what it would send, without sending, unless run with --apply. Prints account
numbers only, never addresses.
Run inside the api image: python scripts/clerk_import.py [--apply]"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import auth  # noqa: E402
import clerk_auth  # noqa: E402


def body_for(user: dict) -> dict:
    body = {
        "email_address": [user["email"]],
        "email_address_identification_status": ["verified" if user["email_verified_at"] else "reserved"],
        "external_id": str(user["id"]),
        "first_name": user["display_name"][:100],
        "password_digest": user["password_hash"],
        "password_hasher": "bcrypt",
        # The hash was checked when the password was set; Clerk cannot measure it again
        "skip_password_checks": True,
        "skip_legal_checks": True,
    }
    if user.get("created_at"):
        body["created_at"] = user["created_at"].replace(" ", "T")[:19] + "Z"
    return body


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="send to Clerk (default: show only)")
    args = parser.parse_args()
    if not clerk_auth.enabled():
        print("CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY are not both set: nothing to do.")
        return 1
    users = [u for u in auth.users_for_clerk_import() if not u["email"].endswith("@" + auth.NO_EMAIL_DOMAIN)]
    print(f"{len(users)} account(s) to copy into Clerk ({clerk_auth.frontend_host()})")
    failed = 0
    for u in users:
        status = "verified" if u["email_verified_at"] else "reserved"
        if not args.apply:
            print(f"  account {u['id']}: would be created, address {status}")
            continue
        try:
            created = clerk_auth.create_user(body_for(u))
            auth.set_clerk_user_id(u["id"], created["id"])
            print(f"  account {u['id']}: created, address {status}")
        except clerk_auth.ClerkError as e:
            failed += 1
            print(f"  account {u['id']}: FAILED {e}")
        time.sleep(0.5)   # the user-creation endpoint is rate limited
    if not args.apply:
        print("Nothing sent. Run again with --apply to create them.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
