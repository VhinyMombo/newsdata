#!/usr/bin/env python3
"""
Build/update a Chroma vector DB from newspaper data.

By default reads from Google Sheets (all 4 source tabs).
Fall back to local CSVs by passing --csv-paths explicitly.

Usage:
    python scripts/newspaper_pipeline/create_newspaper_db.py          # reads from Google Sheets
    python scripts/newspaper_pipeline/create_newspaper_db.py --reset  # full rebuild from Sheets
    python scripts/newspaper_pipeline/create_newspaper_db.py --csv-paths Newspaperdata/*.csv  # legacy CSV mode
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


def load_from_sheets() -> list[Document]:
    """Read all articles from Google Sheets and convert to LangChain Documents."""
    from sheets_client import SheetsClient
    client = SheetsClient()
    rows = client.read_all_articles()
    if not rows:
        raise ValueError("No articles found in Google Sheets. Have the scrapers run yet?")
    return _rows_to_documents(rows)


def _rows_to_documents(rows: list[dict], source_file: str = "google_sheets") -> list[Document]:
    """Convert raw row dicts to LangChain Documents with URL deduplication."""
    docs: list[Document] = []
    seen_urls: set[str] = set()

    for i, row in enumerate(rows):
        source         = _normalize_str(row.get("source"))
        category       = _normalize_str(row.get("category"))
        title          = _normalize_str(row.get("title"))
        published_time = _normalize_str(row.get("published_time"))
        url            = _normalize_str(row.get("url"))
        text           = _normalize_str(row.get("text"))

        if not text or not url or url in seen_urls:
            continue
        seen_urls.add(url)

        parts = []
        if title:
            parts.append(f"Titre: {title}")
        if category:
            parts.append(f"Catégorie: {category}")
        if published_time:
            parts.append(f"Date: {published_time[:10]}")
        if source:
            parts.append(f"Source: {source}")
        parts.append(text)
        page_content = "\n\n".join(parts)

        metadata = {
            "source":         source,
            "category":       category,
            "title":          title,
            "published_time": published_time,
            "source_url":     url,
            "source_file":    source_file,
            "row":            i,
            "kind":           "newspaper",
        }
        docs.append(Document(page_content=page_content, metadata=metadata))

    if not docs:
        raise ValueError("No documents created (all rows were empty or duplicate).")
    return docs


def make_doc_id(url: str) -> str:
    """Deterministic ID from URL so upsert never creates duplicates."""
    return hashlib.md5(url.encode()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a Chroma DB from Google Sheets data (or local CSVs via --csv-paths)."
    )
    parser.add_argument(
        "--csv-paths",
        type=Path,
        nargs="+",
        default=None,  # None = use Google Sheets; pass paths to use local CSVs
        help="Local CSV paths (legacy). Omit to read from Google Sheets.",
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

    # --- Load documents: prefer Google Sheets, fall back to local CSVs ---
    if args.csv_paths:
        print(f"💾 Loading from {len(args.csv_paths)} local CSV file(s)...")
        import pandas as pd

        def load_newspaper_csvs(paths, max_rows):
            """Legacy CSV loader."""
            required = {"category", "title", "published_time", "url", "text"}
            rows = []
            for path in paths:
                if not path.exists():
                    raise FileNotFoundError(f"{path}")
                df = pd.read_csv(path)
                fname = path.stem.lower()
                if fname.startswith("gabonmediatime"): source = "gabonmediatime"
                elif fname.startswith("gabonreview"): source = "gabonreview"
                elif fname.startswith("gabonactu"): source = "gabonactu"
                elif fname.startswith("lunion"): source = "lunion"
                else: source = "unknown"
                for _, row in df.iterrows():
                    r = dict(row)
                    r["source"] = source
                    rows.append(r)
            return _rows_to_documents(rows, source_file="csv")

        docs = load_newspaper_csvs(args.csv_paths, max_rows=args.max_rows)
    else:
        print("📊 Reading articles from Google Sheets...")
        docs = load_from_sheets()
    print(f"  → {len(docs)} unique articles loaded.")

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
