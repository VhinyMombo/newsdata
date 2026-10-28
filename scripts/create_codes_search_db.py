"""
Build the search collection of the legal codes corpus from the codes collection.

The codes collection (create_codes_db.py) keeps one document per article for
reading and for the answer prompt; this script writes next to it the documents
search runs on: articles under clean titles, one document per row of the finance
laws' tables, and their prose (see codes_search.py). Each one carries the id of
its article, so the ids the app already serves do not change.

Usage:
  python scripts/create_codes_search_db.py
  python scripts/create_codes_search_db.py --persist-dir codes_chroma_db --embed-model snowflake-arctic-embed2

Run it again whenever the codes collection is rebuilt, then restart the API
(the live collection is replaced only at the end, so search keeps working meanwhile).
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).parent.parent   # project root (rag/)
sys.path.insert(0, str(ROOT_DIR))

import chromadb
from langchain_ollama.embeddings import OllamaEmbeddings

from codes_search import search_documents


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the codes search collection.")
    parser.add_argument("--persist-dir", type=Path, default=ROOT_DIR / "codes_chroma_db")
    parser.add_argument("--source", default="codes_gabon", help="Codes collection (one document per article).")
    parser.add_argument("--collection", default="codes_gabon_search")
    parser.add_argument(
        "--embed-model",
        default=os.getenv("CODES_EMBED_MODEL", "snowflake-arctic-embed2"),
        help="Ollama embedding model; the API must query with the same one.",
    )
    parser.add_argument("--num-ctx", type=int, default=2048)
    args = parser.parse_args()

    client = chromadb.PersistentClient(path=str(args.persist_dir))
    src = client.get_collection(args.source).get(include=["documents", "metadatas"])
    ids, texts, metas = search_documents(src["ids"], src["documents"], src["metadatas"])
    kinds = {k: sum(m["kind"] == k for m in metas) for k in ("article", "row", "prose")}
    print(f"{len(src['ids'])} articles -> {len(ids)} search documents {kinds}")

    # Built under a temporary name and swapped in at the end: deleting the live
    # collection first left the API's law search failing for the whole rebuild
    building = args.collection + "_building"
    if building in [c.name for c in client.list_collections()]:
        client.delete_collection(building)
    # Chroma's default search breadth lost two right answers out of 45 on the
    # benchmark once the collection grew to 5,600 short documents
    col = client.create_collection(
        building,
        metadata={"hnsw:search_ef": 200, "hnsw:construction_ef": 200,
                  "embed_model": args.embed_model},
    )
    embedder = OllamaEmbeddings(model=args.embed_model, num_ctx=args.num_ctx)
    # Modest batches: one request bundling thousands of documents crashes the
    # Ollama runner (see create_codes_db.py)
    BATCH = 100
    for i in range(0, len(ids), BATCH):
        sl = slice(i, i + BATCH)
        col.add(ids=ids[sl], documents=texts[sl], metadatas=metas[sl],
                embeddings=embedder.embed_documents(texts[sl]))
        print(f"  ... {min(i + BATCH, len(ids))}/{len(ids)} embedded")
    if args.collection in [c.name for c in client.list_collections()]:
        client.delete_collection(args.collection)
    col.modify(name=args.collection)
    print(f"Saved {col.count()} documents to {args.collection} in {args.persist_dir.resolve()} "
          f"({args.embed_model})")


if __name__ == "__main__":
    main()
