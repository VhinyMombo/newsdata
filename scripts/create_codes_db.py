from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

ROOT_DIR = Path(__file__).parent.parent   # project root (rag/)
DATA_DIR = ROOT_DIR / "data"              # where get_codes.py saves CSVs

import pandas as pd
from langchain_chroma import Chroma
from langchain_core.documents import Document
from langchain_ollama.embeddings import OllamaEmbeddings


def _normalize_str(value: object) -> str:
    if value is None:
        return ""
    s = str(value).strip()
    return "" if s.lower() == "nan" else s


def load_codes_csvs(paths: list[Path], max_rows: int | None) -> list[Document]:
    required = {"code", "source_url", "type", "numero", "contexte", "texte"}
    docs: list[Document] = []

    remaining = max_rows
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(f"CSV file not found: {path}")

        df = pd.read_csv(path)
        if required - set(df.columns):
            missing = sorted((required - set(df.columns)))
            raise ValueError(f"{path} missing required columns: {missing}")

        if remaining is not None:
            if remaining <= 0:
                break
            df = df.head(remaining)
            remaining -= len(df)

        for i, row in df.iterrows():
            code = _normalize_str(row.get("code"))
            numero = _normalize_str(row.get("numero"))
            type_ = _normalize_str(row.get("type"))
            contexte = _normalize_str(row.get("contexte"))
            texte = _normalize_str(row.get("texte"))
            source_url = _normalize_str(row.get("source_url"))

            if not texte:
                continue

            title_parts = [p for p in [code, type_, numero] if p]
            title = " - ".join(title_parts)

            parts = []
            if title:
                parts.append(title)
            if contexte:
                parts.append(contexte)
            parts.append(texte)
            page_content = "\n\n".join(parts)

            metadata = {
                "code": code,
                "numero": numero,
                "type": type_,
                "contexte": contexte,
                "source_url": source_url,
                "source_file": str(path),
                "row": int(i),
                "kind": code or "code",
            }

            docs.append(Document(page_content=page_content, metadata=metadata))

    if not docs:
        raise ValueError("No documents created from CSVs (all rows empty?).")

    # De-duplicate identical legal snippets across files.
    deduped: list[Document] = []
    seen: set[tuple[str, str, str, str]] = set()
    for d in docs:
        m = d.metadata or {}
        key = (
            str(m.get("code", "")),
            str(m.get("type", "")),
            str(m.get("numero", "")),
            d.page_content,
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(d)

    return deduped


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a Chroma DB from tous_les_codes.csv (all legal codes)."
    )
    parser.add_argument(
        "--csv-paths",
        type=Path,
        nargs="+",
        default=[DATA_DIR / "tous_les_codes.csv"],
        help="One or more CSV paths (default: data/tous_les_codes.csv).",
    )
    parser.add_argument(
        "--persist-dir",
        type=Path,
        default=ROOT_DIR / "codes_chroma_db",
        help="Directory to persist Chroma data.",
    )
    parser.add_argument(
        "--collection",
        type=str,
        default="codes_gabon",
        help="Chroma collection name (e.g. codes_gabon).",
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

    docs = load_codes_csvs(list(args.csv_paths), max_rows=args.max_rows)

    embedding = OllamaEmbeddings(model=args.embed_model)
    Chroma.from_documents(
        documents=docs,
        embedding=embedding,
        collection_name=args.collection,
        persist_directory=str(persist_dir),
    )

    print(
        f"Saved {len(docs)} documents to Chroma.\n"
        f"- collection: {args.collection}\n"
        f"- persist dir: {persist_dir.resolve()}\n"
        f"- csvs: {', '.join(str(p.resolve()) for p in args.csv_paths)}\n"
        f"- embed model: {args.embed_model}"
    )


if __name__ == "__main__":
    main()

