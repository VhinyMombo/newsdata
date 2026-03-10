#!/usr/bin/env python3
"""
Build/update a Chroma vector DB from newspaper CSVs (GabonReview + GabonMediaTime).

Uses upsert() with a URL-based ID so only NEW articles are added on incremental runs —
existing articles are never duplicated. Use --reset for a full rebuild.

Usage:
    python scripts/newspaper_pipeline/create_newspaper_db.py          # incremental update
    python scripts/newspaper_pipeline/create_newspaper_db.py --reset   # full rebuild
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import os
import shutil
from pathlib import Path

import chromadb
import pandas as pd
from langchain_core.documents import Document
from langchain_ollama.embeddings import OllamaEmbeddings

ROOT_DIR = Path(__file__).parent.parent.parent  # scripts/newspaper_pipeline/ → scripts/ → rag/
DATA_DIR = ROOT_DIR / "Newspaperdata"


def _normalize_str(value: object) -> str:
    if value is None:
        return ""
    s = str(value).strip()
    return "" if s.lower() == "nan" else s


def load_newspaper_csvs(paths: list[Path], max_rows: int | None) -> list[Document]:
    """Load newspaper CSVs and convert each row into a LangChain Document."""
    required = {"category", "title", "published_time", "url", "text"}
    docs: list[Document] = []

    remaining = max_rows
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(f"CSV file not found: {path}")

        df = pd.read_csv(path)
        if required - set(df.columns):
            missing = sorted(required - set(df.columns))
            raise ValueError(f"{path} missing required columns: {missing}")

        if remaining is not None:
            if remaining <= 0:
                break
            df = df.head(remaining)
            remaining -= len(df)

        # Derive source name from filename (gabonreview_* → gabonreview, etc.)
        fname = path.stem.lower()
        if fname.startswith("gabonmediatime"):
            source = "gabonmediatime"
        elif fname.startswith("gabonreview"):
            source = "gabonreview"
        else:
            source = "unknown"

        for i, row in df.iterrows():
            category       = _normalize_str(row.get("category"))
            title          = _normalize_str(row.get("title"))
            published_time = _normalize_str(row.get("published_time"))
            url            = _normalize_str(row.get("url"))
            text           = _normalize_str(row.get("text"))

            if not text:
                continue

            # Build rich page_content for embedding
            parts = []
            if title:
                parts.append(f"Titre: {title}")
            if category:
                parts.append(f"Catégorie: {category}")
            if published_time:
                parts.append(f"Date: {published_time[:10]}")
            parts.append(f"Source: {source}")
            parts.append(text)
            page_content = "\n\n".join(parts)

            metadata = {
                "source":         source,
                "category":       category,
                "title":          title,
                "published_time": published_time,
                "source_url":     url,
                "source_file":    str(path),
                "row":            int(i),
                "kind":           "newspaper",
            }

            docs.append(Document(page_content=page_content, metadata=metadata))

    if not docs:
        raise ValueError("No documents created from CSVs (all rows empty?).")

    # De-duplicate by URL (same article can appear in multiple CSV files)
    deduped: list[Document] = []
    seen_urls: set[str] = set()
    for d in docs:
        url = d.metadata.get("source_url", "")
        if url in seen_urls:
            continue
        seen_urls.add(url)
        deduped.append(d)

    return deduped


def make_doc_id(url: str) -> str:
    """Deterministic ID from URL so upsert never creates duplicates."""
    return hashlib.md5(url.encode()).hexdigest()


def main() -> None:
    # Collect all newspaper CSVs from Newspaperdata/ (both sources)
    default_csvs = sorted(
        list(DATA_DIR.glob("gabonreview_*.csv"))
        + list(DATA_DIR.glob("gabonmediatime_*.csv"))
    )

    parser = argparse.ArgumentParser(
        description="Build a Chroma DB from newspaper CSVs (GabonReview + GabonMediaTime)."
    )
    parser.add_argument(
        "--csv-paths",
        type=Path,
        nargs="+",
        default=default_csvs if default_csvs else [DATA_DIR / "*.csv"],
        help="One or more CSV paths (default: all newspaper CSVs in Newspaperdata/).",
    )
    parser.add_argument(
        "--persist-dir",
        type=Path,
        default=ROOT_DIR / "newspaper_chroma_db",
        help="Directory to persist Chroma data.",
    )
    parser.add_argument(
        "--collection",
        type=str,
        default="newspaper_gabon",
        help="Chroma collection name.",
    )
    parser.add_argument(
        "--embed-model",
        type=str,
        default=os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma"),
        help="Ollama embedding model name.",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=None,
        help="Optional limit on number of CSV rows to ingest.",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Delete persist dir before rebuilding.",
    )

    args = parser.parse_args()

    persist_dir: Path = args.persist_dir
    if args.reset and persist_dir.exists():
        shutil.rmtree(persist_dir)
        print("♻️  Removed existing database for full rebuild.")

    docs = load_newspaper_csvs(list(args.csv_paths), max_rows=args.max_rows)

    print(f"Generating embeddings for {len(docs)} articles using '{args.embed_model}'...")
    embedding_model = OllamaEmbeddings(model=args.embed_model)

    # Build ChromaDB client & collection
    client = chromadb.PersistentClient(path=str(persist_dir))
    collection = client.get_or_create_collection(name=args.collection)

    # Prepare data for upsert
    ids        = [make_doc_id(d.metadata["source_url"]) for d in docs]
    texts      = [d.page_content for d in docs]
    metadatas  = [d.metadata for d in docs]

    # Check which IDs already exist in the collection
    existing = set(collection.get(ids=ids, include=[])['ids'])
    new_docs      = [(id_, text, meta) for id_, text, meta in zip(ids, texts, metadatas) if id_ not in existing]

    if not new_docs:
        print("✅ Database already up to date — no new articles to add.")
        return

    new_ids   = [x[0] for x in new_docs]
    new_texts = [x[1] for x in new_docs]
    new_metas = [x[2] for x in new_docs]

    print(f"  → {len(existing)} already in DB, adding {len(new_docs)} new articles...")
    embeddings = embedding_model.embed_documents(new_texts)

    collection.upsert(
        ids=new_ids,
        embeddings=embeddings,
        documents=new_texts,
        metadatas=new_metas,
    )

    total = collection.count()
    print(
        f"\n✅ Done. Added {len(new_docs)} new articles.\n"
        f"  - Total in DB  : {total}\n"
        f"  - Collection   : {args.collection}\n"
        f"  - Persist dir  : {persist_dir.resolve()}\n"
        f"  - Embed model  : {args.embed_model}"
    )


if __name__ == "__main__":
    main()
