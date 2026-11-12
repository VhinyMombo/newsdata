"""Daily quotas on /answer, with the model and the articles simulated (nothing is sent).
Needs the real api.py and its corpus: run inside the api image,
python tests/test_answer_quota.py"""
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent))
import api  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

api.limiter.enabled = False   # the per-minute limit is not under test
client = TestClient(api.app)
ARTICLE = {"title": "Titre", "source": "Source", "date": "2026-11-12", "url": "u", "content": "Texte."}


def ask(question, ip="10.0.0.1"):
    return client.post("/answer", headers={"X-Forwarded-For": ip},
                       json={"question": question, "corpus": "presse", "urls": ["u"]})


def fresh_day(anon=2, total=5):
    api._answer_quota.update(day=None, total=0, by={})
    api.ANSWER_DAILY_ANON, api.ANSWER_DAILY_TOTAL = anon, total


@patch.object(api, "_fetch_articles", lambda urls: [ARTICLE])
@patch.object(api, "build_rag_prompt", lambda q, items: q)
@patch.object(api, "_llm", SimpleNamespace(stream=lambda m: iter([SimpleNamespace(content="Réponse.")])))
def run():
    fresh_day()
    assert ask("question une").status_code == 200
    assert ask("question deux").status_code == 200
    r = ask("question trois")
    assert r.status_code == 429 and "Connectez-vous" in r.json()["detail"], r.text
    # The same question again comes from the cache: free, so still answered
    assert ask("question une").headers["X-Answer-Source"] == "cache"
    # Another address has its own quota
    assert ask("question trois", ip="10.0.0.2").status_code == 200

    fresh_day(anon=10, total=3)
    for i in range(3):
        assert ask(f"site {i}", ip=f"10.0.1.{i}").status_code == 200
    r = ask("site 3", ip="10.0.1.9")
    assert r.status_code == 429 and "demain" in r.json()["detail"], r.text

    # A new day starts the counts again
    api._answer_quota["day"] = "hier"
    assert ask("lendemain", ip="10.0.1.9").status_code == 200
    print("quota tests: ok")


if __name__ == "__main__":
    run()
