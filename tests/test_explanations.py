"""« Expliquer » answers kept a day in memory, with the model and the articles simulated.
Needs the real api.py and its corpus: run inside the api image,
python tests/test_explanations.py"""
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent))
import api  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

api.limiter.enabled = False
client = TestClient(api.app)
calls = []


def fake_articles(urls):
    return [api.ContextArticle(title=f"Titre {u}", source="Source", date="2026-11-12", url=u, ref=i)
            for i, u in enumerate(urls, 1) if u != "absent"]


def fake_stream(messages):
    calls.append(1)
    return iter([SimpleNamespace(content="L'article [1] dit ceci, et [2] le complète.")])


def explain(url, others=("b", "c")):
    q = f"{api.EXPLAIN_PREFIX} s'inscrit-il : « Titre {url} » ?"
    return client.post("/answer", json={"question": q, "corpus": "presse", "urls": [url, *others]})


@patch.object(api, "_fetch_articles", fake_articles)
@patch.object(api, "build_rag_prompt", lambda q, items: q)
@patch.object(api, "_llm", SimpleNamespace(stream=fake_stream))
def run():
    api._answer_quota.update(day=None, total=0, by={})
    assert client.get("/explication", params={"url": "a"}).status_code == 404
    explain("a").text
    kept = client.get("/explication", params={"url": "a"}).json()
    assert kept["answer"].startswith("L'article [1]") and kept["answer_id"], kept
    assert [s["url"] for s in kept["sources"]] == ["a", "b", "c"], kept["sources"]
    assert kept["sources"][1]["title"] == "Titre b"
    # The first explanation of the day stays, even if another is written meanwhile
    explain("a", others=("d", "e")).text
    assert [s["url"] for s in client.get("/explication", params={"url": "a"}).json()["sources"]] == ["a", "b", "c"]

    # Not an « Expliquer » question: nothing kept
    client.post("/answer", json={"question": "Autre question ?", "corpus": "presse", "urls": ["z"]}).text
    assert client.get("/explication", params={"url": "z"}).status_code == 404

    # After a day it is gone, and the next one replaces it
    api._explanations["a"]["expires"] = 0
    assert client.get("/explication", params={"url": "a"}).status_code == 404
    explain("a", others=("f",)).text
    assert [s["url"] for s in client.get("/explication", params={"url": "a"}).json()["sources"]] == ["a", "f"]
    print(f"explanation tests: ok ({len(calls)} generations)")


if __name__ == "__main__":
    run()
