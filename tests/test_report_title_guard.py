"""The unattended report's guard against the outdated title, with the model simulated.
Run: .venv/bin/python tests/test_report_title_guard.py"""
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

# Only the guard: the real api.py would load the whole corpus, and nothing must be sent
api = MagicMock()
sys.modules.update(api=api, push_notify=MagicMock(), report_archive=MagicMock())
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
import generate_scheduled_report as report  # noqa: E402

ROWS = [("2026-11-06", "source", "", "Oligui Nguema et Xi Jinping scellent six accords", "u1")]
BAD = "La visite du président de la Transition en Chine."
GOOD = "La visite du président Oligui Nguema en Chine."


def run(answers, rows=ROWS):
    api._report_llm.invoke.reset_mock()
    api._report_llm.invoke.side_effect = [SimpleNamespace(content=a) for a in answers]
    return report.write_report([], rows), api._report_llm.invoke.call_count


def test_clean_text_is_kept_at_once():
    assert run([GOOD]) == (GOOD, 1)


def test_outdated_title_is_asked_again():
    assert run([BAD, GOOD]) == (GOOD, 2)


def test_any_spelling_is_caught():
    assert run(["Le Président de la transition arrive.", GOOD]) == (GOOD, 2)
    assert run(["Le president  de  la TRANSITION arrive.", GOOD]) == (GOOD, 2)


def test_three_failures_still_publish_without_the_title():
    text, calls = run([BAD, BAD, BAD])
    assert calls == 3
    assert text == "La visite du président en Chine."


def test_a_source_headline_saying_it_is_respected():
    rows = ROWS + [("2026-11-06", "source", "", "Le président de la transition malien à Dakar", "u2")]
    assert run([BAD], rows) == (BAD, 1)


def test_other_uses_of_the_word_stay():
    text = "La transition urbaine de Libreville avance."
    assert run([text]) == (text, 1)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
