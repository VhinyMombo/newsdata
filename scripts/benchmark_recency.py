"""Benchmark: recency-aware reranking of non-temporal queries.

Compares the previous ranking of the /search non-temporal path (pure semantic
distance) with the current one (0.85 x similarity + 0.15 x recency, 45-day
half-life) on evolving-topic questions that carry no temporal keyword.

Reproduces the exact /search pipeline: embed, fetch 30, dedup chunks by URL,
relevance threshold, then rank. Requires Ollama (embeddings) and the local
ChromaDB. Run from the repo root:

    .venv/bin/python scripts/benchmark_recency.py
"""

import sys
import time
import statistics
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import api  # noqa: E402  (loads the collection and embedder once)

# Evolving topics phrased without temporal keywords, so parse_time_window
# classifies them as non-temporal (the script verifies this).
QUERIES = [
    "dette de l'état",
    "prix du carburant au Gabon",
    "composition du gouvernement",
    "pont de la Baie des Rois",
    "situation des enseignants",
    "championnat national de football",
    "production de manganèse",
    "élection présidentielle",
    "bourses des étudiants",
    "pénurie d'eau à Libreville",
    "salaire des fonctionnaires",
    "lutte contre la vie chère",
]

TOP_K = 5


def age_days(meta, now_ts):
    ts = float(meta.get("published_ts") or 0)
    return (now_ts - ts) / 86400.0 if ts else float("inf")


def candidates_for(question):
    """/search non-temporal path up to (but excluding) ranking."""
    q_vec = api._embedder.embed_query(question)
    raw = api._collection.query(
        query_embeddings=[q_vec],
        n_results=30,
        include=["documents", "metadatas", "distances"],
    )
    combined = list(zip(raw["metadatas"][0], raw["distances"][0], raw["documents"][0]))
    seen, deduped = set(), []
    for m, d, doc in combined:
        key = m.get("source_url", "")
        if key in seen:
            continue
        seen.add(key)
        deduped.append((m, d, doc))
    return [(m, d, doc) for m, d, doc in deduped if d < api.RELEVANCE_THRESHOLD]


def rank_of_newest(ranking, newest_url):
    for i, (m, _, _) in enumerate(ranking, 1):
        if m.get("source_url") == newest_url:
            return i
    return None


def main():
    now_ts = time.time()
    rows = []
    agg = {"old_top1": [], "new_top1": [], "old_med": [], "new_med": [],
           "old_dist": [], "new_dist": [], "old_newest_in5": 0, "new_newest_in5": 0}

    for q in QUERIES:
        if api.parse_time_window(q) is not None:
            print(f"SKIP (parsed as temporal): {q}")
            continue
        cands = candidates_for(q)
        if len(cands) < TOP_K:
            print(f"SKIP (only {len(cands)} candidates): {q}")
            continue

        old = cands[:TOP_K]  # previous behavior: distance order
        new = api.temporal_rank(
            cands, now_ts=now_ts,
            sim_weight=api.NONTEMPORAL_SIM_WEIGHT,
            rec_weight=api.NONTEMPORAL_REC_WEIGHT,
            half_life_days=api.NONTEMPORAL_HALF_LIFE_DAYS,
        )[:TOP_K]

        newest_url = max(cands, key=lambda c: float(c[0].get("published_ts") or 0))[0]["source_url"]
        r_old, r_new = rank_of_newest(old, newest_url), rank_of_newest(new, newest_url)

        row = {
            "query": q,
            "n_cand": len(cands),
            "old_top1_age": age_days(old[0][0], now_ts),
            "new_top1_age": age_days(new[0][0], now_ts),
            "old_med_age": statistics.median(age_days(m, now_ts) for m, _, _ in old),
            "new_med_age": statistics.median(age_days(m, now_ts) for m, _, _ in new),
            "old_mean_dist": statistics.mean(d for _, d, _ in old),
            "new_mean_dist": statistics.mean(d for _, d, _ in new),
            "newest_rank_old": r_old,
            "newest_rank_new": r_new,
        }
        rows.append(row)
        agg["old_top1"].append(row["old_top1_age"])
        agg["new_top1"].append(row["new_top1_age"])
        agg["old_med"].append(row["old_med_age"])
        agg["new_med"].append(row["new_med_age"])
        agg["old_dist"].append(row["old_mean_dist"])
        agg["new_dist"].append(row["new_mean_dist"])
        agg["old_newest_in5"] += r_old is not None
        agg["new_newest_in5"] += r_new is not None

    print(f"\n{'query':<34} {'top1 age o→n':>14} {'med age o→n':>14} "
          f"{'mean dist o→n':>15} {'newest rank o→n':>16}")
    for r in rows:
        fmt_rank = lambda x: str(x) if x else "–"
        print(f"{r['query']:<34} {r['old_top1_age']:>5.0f} → {r['new_top1_age']:<5.0f} "
              f"{r['old_med_age']:>6.0f} → {r['new_med_age']:<5.0f} "
              f"{r['old_mean_dist']:>6.3f} → {r['new_mean_dist']:<6.3f} "
              f"{fmt_rank(r['newest_rank_old']):>7} → {fmt_rank(r['newest_rank_new'])}")

    n = len(rows)
    print(f"\n=== Aggregate over {n} queries (top-{TOP_K}) ===")
    print(f"median top-1 age      : {statistics.median(agg['old_top1']):.0f} d → "
          f"{statistics.median(agg['new_top1']):.0f} d")
    print(f"median of median ages : {statistics.median(agg['old_med']):.0f} d → "
          f"{statistics.median(agg['new_med']):.0f} d")
    print(f"mean distance (top-5) : {statistics.mean(agg['old_dist']):.3f} → "
          f"{statistics.mean(agg['new_dist']):.3f}")
    print(f"newest candidate in top-5 : {agg['old_newest_in5']}/{n} → {agg['new_newest_in5']}/{n}")


def sweep():
    """Sensitivity sweep over (recency weight, half-life).

    Candidates are embedded and fetched once per query, then every
    configuration is evaluated on the same pool, so the sweep costs one
    embedding call per query regardless of grid size.
    """
    now_ts = time.time()
    pools = []
    for q in QUERIES:
        if api.parse_time_window(q) is not None:
            continue
        cands = candidates_for(q)
        if len(cands) >= TOP_K:
            pools.append(cands)
    n = len(pools)

    rec_weights = [0.0, 0.05, 0.10, 0.15, 0.25, 0.40]
    half_lives = [7.0, 21.0, 45.0, 90.0]

    print(f"\n=== Sweep over {n} queries: median top-1 age (d) | newest in top-5 | mean dist ===")
    header = f"{'rec_weight':>10} |" + "".join(f"  hl={int(hl)}d{'':<12}" for hl in half_lives)
    print(header)
    for rw in rec_weights:
        cells = []
        for hl in half_lives:
            top1_ages, dists, newest_hits = [], [], 0
            for cands in pools:
                ranked = api.temporal_rank(
                    cands, now_ts=now_ts,
                    sim_weight=1.0 - rw, rec_weight=rw, half_life_days=hl,
                )[:TOP_K]
                top1_ages.append(age_days(ranked[0][0], now_ts))
                dists.append(statistics.mean(d for _, d, _ in ranked))
                newest_url = max(
                    cands, key=lambda c: float(c[0].get("published_ts") or 0)
                )[0]["source_url"]
                newest_hits += rank_of_newest(ranked, newest_url) is not None
            cells.append(
                f"{statistics.median(top1_ages):>5.0f} {newest_hits:>2}/{n} {statistics.mean(dists):.3f}"
            )
            if rw == 0.0:
                break  # half-life is irrelevant at zero recency weight
        print(f"{rw:>10.2f} |  " + "    ".join(cells))


if __name__ == "__main__":
    main()
    sweep()
