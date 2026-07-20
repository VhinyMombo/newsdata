"""Backfill topical rubriques for articles whose declared category is generic.

About a quarter of the corpus carries a front-page rubrique ("À la une",
"Actualités"…) that says nothing about the topic, concentrated in a few
sources (directinfosgabon, 7joursinfo, insidenews241…). This script:

1. finds non-chunk entries whose category is generic or missing;
2. maps mono-thematic outlets directly (gabonallsport → Sport, no LLM);
3. classifies the rest by title with the local LLM, in batches, into the
   project's canonical taxonomy;
4. updates ChromaDB metadata only (no re-embedding), on the article's entry
   and all its chunks, keeping the original under `category_original` and
   marking `category_source: "llm"` so the pass is auditable, resumable and
   reversible.

The frontend map/dashboard read data.json: they pick the new rubriques up at
the next pipeline export. Reports and /search read Chroma directly.

    .venv/bin/python scripts/backfill_categories.py --dry-run --limit 40
    .venv/bin/python scripts/backfill_categories.py            # full pass
"""

import argparse
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import api  # noqa: E402  (chroma collection + chat model config)

from langchain_core.messages import HumanMessage, SystemMessage  # noqa: E402
from langchain_ollama.chat_models import ChatOllama  # noqa: E402

TAXONOMY = [
    "Politique", "Économie", "Société", "Sport", "Faits Divers / Justice",
    "Culture", "Provinces", "Environnement", "Santé", "Éducation",
    "Administration", "Diplomatie", "International", "IA / Numérique",
    "Communication", "Autres",
]

MONO_THEME_SOURCES = {"gabonallsport": "Sport"}

GENERIC_RE = re.compile(r"^(a la une|actualit|news|infos?$|non class|uncategorized)")

SYSTEM = """\
Tu classes des titres d'articles de presse gabonaise dans une rubrique éditoriale.
Rubriques autorisées (réponds avec l'orthographe exacte) :
""" + "\n".join(f"- {t}" for t in TAXONOMY) + """

Règles :
- Une seule rubrique par titre, la plus spécifique qui convient.
- « Provinces » : actualité locale hors Libreville. « International » : hors Gabon.
- « Autres » uniquement si aucune rubrique ne convient.
- Réponds EXACTEMENT une ligne par titre, au format « N. Rubrique », sans commentaire.
"""


def norm(s: str) -> str:
    return unicodedata.normalize("NFD", (s or "").lower().strip()) \
        .encode("ascii", "ignore").decode()


# Accent-insensitive lookup of model output → canonical taxonomy label
TAXO_LOOKUP = {norm(t): t for t in TAXONOMY}
TAXO_LOOKUP.update({"faits divers": "Faits Divers / Justice",
                    "justice": "Faits Divers / Justice",
                    "numerique": "IA / Numérique"})


def classify_batch(llm, titles: list[str]) -> list[str | None]:
    """One LLM call → one canonical category (or None) per title."""
    numbered = "\n".join(f"{i}. {t}" for i, t in enumerate(titles, 1))
    out = llm.invoke([SystemMessage(content=SYSTEM),
                      HumanMessage(content=numbered)]).content
    result: list[str | None] = [None] * len(titles)
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s*[.):-]\s*(.+?)\s*$", line)
        if not m:
            continue
        i = int(m.group(1)) - 1
        if 0 <= i < len(titles):
            result[i] = TAXO_LOOKUP.get(norm(m.group(2)))
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None,
                    help="max articles to process (for pilots)")
    ap.add_argument("--batch-size", type=int, default=20)
    ap.add_argument("--dry-run", action="store_true",
                    help="classify and print, but write nothing")
    args = ap.parse_args()

    res = api._collection.get(include=["metadatas"])
    ids, metas = res["ids"], res["metadatas"]

    # Group every entry (article + its chunks) by URL so one classification
    # updates them all
    by_url: dict[str, list[int]] = {}
    for i, m in enumerate(metas):
        if m and m.get("source_url"):
            by_url.setdefault(m["source_url"], []).append(i)

    todo = []  # (url, title, source, original_category, [indices])
    for url, idxs in by_url.items():
        main_i = next((i for i in idxs if not metas[i].get("chunk", 0)), idxs[0])
        m = metas[main_i]
        if m.get("category_source") == "llm":
            continue  # already backfilled — resumable
        if not GENERIC_RE.match(norm(m.get("category"))) and norm(m.get("category")):
            continue
        title = m.get("title", "")
        if not title:
            continue
        todo.append((url, title, m.get("source", ""), m.get("category", ""), idxs))

    print(f"{len(todo)} articles à rubrique générique/absente à traiter")
    if args.limit:
        todo = todo[:args.limit]
        print(f"(limité à {len(todo)} pour ce passage)")

    llm = ChatOllama(model=api.CHAT_MODEL, temperature=0,
                     **({"reasoning": False}
                        if api.CHAT_MODEL.lower().startswith(api._REASONING_MODEL_PREFIXES)
                        else {}))

    assigned = Counter()
    skipped = 0
    updated = 0

    # Mono-thematic outlets first: free and exact
    direct = [t for t in todo if t[2] in MONO_THEME_SOURCES]
    needs_llm = [t for t in todo if t[2] not in MONO_THEME_SOURCES]

    def apply(url, title, source, original, idxs, category):
        nonlocal updated
        assigned[category] += 1
        if args.dry_run:
            print(f"  [{category:24s}] {title[:70]}")
            return
        upd_ids = [ids[i] for i in idxs]
        upd_metas = []
        for i in idxs:
            m = dict(metas[i])
            m["category_original"] = m.get("category", "")
            m["category"] = category
            m["category_source"] = "llm" if source not in MONO_THEME_SOURCES else "source-rule"
            upd_metas.append(m)
        api._collection.update(ids=upd_ids, metadatas=upd_metas)
        updated += len(upd_ids)

    for t in direct:
        apply(*t, MONO_THEME_SOURCES[t[2]])
    if direct:
        print(f"{len(direct)} articles {list(MONO_THEME_SOURCES)[0]} → Sport (règle de source)")

    for start in range(0, len(needs_llm), args.batch_size):
        batch = needs_llm[start:start + args.batch_size]
        try:
            cats = classify_batch(llm, [t[1] for t in batch])
        except Exception as e:
            print(f"  batch {start}: erreur LLM ({e}), ignoré")
            skipped += len(batch)
            continue
        for t, cat in zip(batch, cats):
            if cat is None:
                skipped += 1
                continue
            apply(*t, cat)
        done = min(start + args.batch_size, len(needs_llm))
        print(f"  {done}/{len(needs_llm)} classés…", flush=True)

    print("\n=== Répartition attribuée ===")
    for cat, n in assigned.most_common():
        print(f"  {cat:24s} {n}")
    print(f"\n{sum(assigned.values())} articles classés, {skipped} sans réponse exploitable, "
          f"{updated} entrées Chroma mises à jour{' (dry-run: rien écrit)' if args.dry_run else ''}")


if __name__ == "__main__":
    main()
