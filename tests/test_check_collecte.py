"""The collection alert, with the API and the mail simulated and a throwaway state file.
Run: .venv/bin/python tests/test_check_collecte.py"""
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

os.environ["CHECK_STATE_PATH"] = os.path.join(tempfile.mkdtemp(), "state.json")
os.environ["ADMIN_EMAILS"] = "chef@example.invalid, autre@example.invalid"
os.environ["SMTP_PASSWORD"] = "not-a-real-one"
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
import check_collecte as cc  # noqa: E402

NOW = datetime(2026, 11, 4, 18, 30, tzinfo=timezone.utc)


def today(*hours_ago):
    return {"latest": [{"time": (NOW - timedelta(hours=h)).isoformat()} for h in hours_ago]}


def run(api, now=NOW, mail_error=None):
    """One check; returns the subjects sent (one per run, to every admin)."""
    effect = api if isinstance(api, Exception) else None
    with patch.object(cc, "fetch_today", return_value=api, side_effect=effect), \
         patch.object(cc.mailer, "send", side_effect=mail_error) as send:
        cc.check(now)
    return send.call_args_list


def reset():
    cc.STATE_PATH.unlink(missing_ok=True)


def test_fresh_articles_send_nothing():
    reset()
    assert not run(today(2))


def test_silence_alerts_once_every_admin():
    reset()
    sent = run(today(19))
    assert sorted(c.args[0] for c in sent) == ["autre@example.invalid", "chef@example.invalid"]
    assert "en panne" in sent[0].args[1]
    assert not run(today(20), NOW + timedelta(hours=1))


def test_reminder_after_a_day_then_recovery_once():
    reset()
    run(today(19))
    assert "rappel" in run(today(43), NOW + timedelta(hours=24))[0].args[1]
    assert "repris" in run(today(1))[0].args[1]
    assert not run(today(1))


def test_a_date_in_the_future_does_not_hide_the_silence():
    reset()
    assert run(today(-48, 30))


def test_api_down_alerts():
    reset()
    sent = run(OSError("down"))
    assert "ne répond pas" in sent[0].args[2]


def test_no_article_at_all_alerts():
    reset()
    assert run({"latest": []})


def test_failed_send_is_tried_again():
    reset()
    try:
        run(today(19), mail_error=OSError("smtp"))
        raise AssertionError("the failure should surface in the cron log")
    except OSError:
        pass
    assert not cc.STATE_PATH.exists()
    assert run(today(19))


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} tests passed")
