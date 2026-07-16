#!/usr/bin/env python3
"""One-off migration: add numeric `published_ts` to existing ChromaDB entries.

New entries get the field at indexing time (create_newspaper_db.py); this
backfills the ones added before. Metadata-only update — no re-embedding.
Safe to re-run: entries that already have the field are skipped.

Usage:
    .venv/bin/python scripts/backfill_published_ts.py
"""

from datetime import datetime
from pathlib import Path

import chromadb

ROOT_DIR = Path(__file__).parent.parent
PERSIST_DIR = ROOT_DIR / "newspaper_chroma_db"
COLLECTION_NAME = "newspaper_gabon"
BATCH = 500


def to_ts(published_time: str) -> float:
    try:
        return datetime.fromisoformat(published_time).timestamp()
    except (ValueError, TypeError):
        return 0.0


def main() -> None:
    client = chromadb.PersistentClient(path=str(PERSIST_DIR))
    collection = client.get_collection(COLLECTION_NAME)
    total = collection.count()
    print(f"Collection '{COLLECTION_NAME}': {total} entries")

    updated = skipped = unparseable = 0
    offset = 0
    while offset < total:
        page = collection.get(limit=BATCH, offset=offset, include=["metadatas"])
        offset += len(page["ids"])

        ids, metas = [], []
        for id_, meta in zip(page["ids"], page["metadatas"]):
            meta = meta or {}
            if "published_ts" in meta:
                skipped += 1
                continue
            ts = to_ts(meta.get("published_time", ""))
            if ts == 0.0:
                unparseable += 1
            meta["published_ts"] = ts
            ids.append(id_)
            metas.append(meta)

        if ids:
            collection.update(ids=ids, metadatas=metas)
            updated += len(ids)
        print(f"  … {offset}/{total} scanned, {updated} updated", flush=True)

    print(f"\n✅ Done. Updated {updated}, already had it {skipped}, unparseable dates {unparseable}.")


if __name__ == "__main__":
    main()
