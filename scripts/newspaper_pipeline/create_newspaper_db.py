#!/usr/bin/env python3
"""
Build a Chroma vector DB from newspaper CSVs (GabonReview + GabonMediaTime).

Reads CSV files produced by scrape_gabon_review.py and scrape_gabon_media_time.py
(columns: category, title, published_time, url, text) and creates embeddings
stored in a ChromaDB.  A 'source' metadata field is added automatically.

Usage:
    python scripts/create_newspaper_db.py --reset
    python scripts/create_newspaper_db.py --csv-paths Newspaperdata/gabonreview_*.csv
"""

from __future__ import annotations

import argparse
import glob
import os
import shutil
from pathlib import Path

import pandas as pd
from langchain_chroma import Chroma
from langchain_core.documents import Document
from langchain_ollama.embeddings import OllamaEmbeddings

ROOT_DIR = Path(__file__).parent.parent
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

    docs = load_newspaper_csvs(list(args.csv_paths), max_rows=args.max_rows)

    print(f"Creating embeddings for {len(docs)} articles using '{args.embed_model}'...")
    embedding = OllamaEmbeddings(model=args.embed_model)
    Chroma.from_documents(
        documents=docs,
        embedding=embedding,
        collection_name=args.collection,
        persist_directory=str(persist_dir),
    )

    print(
        f"\n✅ Saved {len(docs)} documents to Chroma.\n"
        f"  - collection : {args.collection}\n"
        f"  - persist dir: {persist_dir.resolve()}\n"
        f"  - csvs       : {', '.join(str(p.resolve()) for p in args.csv_paths)}\n"
        f"  - embed model: {args.embed_model}"
    )


if __name__ == "__main__":
    main()
