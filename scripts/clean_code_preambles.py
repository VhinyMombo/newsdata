#!/usr/bin/env python3
"""clean_code_preambles.py — strip what the Journal officiel website wrapped
around the preambles of the scraped codes (menu, news ticker, search box,
"Accueil Les Codes", the title printed two or three times), in place.

Updates, for the preamble entries only:
  - the codes collection (codes_gabon, embeddinggemma), keeping the ids;
  - their documents in the search collection (codes_gabon_search,
    snowflake-arctic-embed2);
  - data/<code>.csv, so that a later rebuild keeps the clean text.

Usage (on the server, in the pipeline container):
  python scripts/clean_code_preambles.py            # shows the changes
  python scripts/clean_code_preambles.py --apply
Then restart the API.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT_DIR))

import chromadb
import pandas as pd
from langchain_ollama.embeddings import OllamaEmbeddings

from codes_search import search_documents


def _from(text: str, marker: str, last: bool = False) -> str:
    i = text.rfind(marker) if last else text.find(marker)
    return text[i:] if i >= 0 else text


def clean(code: str, text: str) -> str:
    """Where each preamble really starts (and, for the Code pénal, ends)."""
    t = text
    if code in ("codes_enfants", "codes_hydrocarbures", "codes_minier"):
        t = _from(t, "JOURNAL OFFICIEL N°").replace("SPéCIAL", "SPÉCIAL")
    elif code == "codes_penal":
        t = _from(t, "PARLEMENT ")[len("PARLEMENT "):] if "PARLEMENT " in t else t
        t = t.split(" LIVRE PREMIER")[0]            # the first heading of the code, not the preamble
    elif code == "codes_nationalites":
        t = _from(t, "Loi n°37/98", last=True)
    elif code == "code_travail":
        t = _from(t, "Loi n°3/94")
    elif code == "loi_de_finances_2026":
        t = _from(t, "Loi n°041/2025")
    elif code == "projet_loi_de_finances_2027":
        t = _from(t, "Loi n°")
    return t.strip()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--persist-dir", type=Path, default=ROOT_DIR / "codes_chroma_db")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    client = chromadb.PersistentClient(path=str(args.persist_dir))
    codes = client.get_collection("codes_gabon")
    got = codes.get(where={"type": "preambule"}, include=["documents", "metadatas"])

    ids, docs, metas = [], [], []
    for id_, doc, meta in zip(got["ids"], got["documents"], got["metadatas"]):
        code = meta.get("code", "")
        title = " - ".join(p for p in [code, "preambule"] if p)
        body = doc[len(title):].lstrip("\n") if doc.startswith(title) else doc
        new = clean(code, body)
        if new == body:
            continue
        print(f"--- {code}: {len(body)} -> {len(new)} caractères\n    {new[:160]}…")
        ids.append(id_); docs.append(f"{title}\n\n{new}"); metas.append(meta)

    if not ids:
        print("Rien à nettoyer.")
        return
    if not args.apply:
        print(f"\n{len(ids)} préambule(s) à nettoyer ; relancer avec --apply.")
        return

    codes.update(ids=ids, documents=docs,
                 embeddings=OllamaEmbeddings(model=os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma")).embed_documents(docs))

    search = client.get_collection("codes_gabon_search")
    old = search.get(where={"article_id": {"$in": ids}})
    if old["ids"]:
        search.delete(ids=old["ids"])
    s_ids, s_texts, s_metas = search_documents(ids, docs, metas)
    embedder = OllamaEmbeddings(model=os.getenv("CODES_EMBED_MODEL", "snowflake-arctic-embed2"), num_ctx=2048)
    search.add(ids=s_ids, documents=s_texts, metadatas=s_metas, embeddings=embedder.embed_documents(s_texts))
    print(f"codes_gabon : {len(ids)} mis à jour ; codes_gabon_search : {len(old['ids'])} remplacés par {len(s_ids)}")

    for meta in metas:
        path = ROOT_DIR / "data" / f"{meta['code']}.csv"
        if not path.exists():
            continue
        df = pd.read_csv(path)
        mask = df["type"] == "preambule"
        df.loc[mask, "texte"] = [clean(meta["code"], str(t)) for t in df.loc[mask, "texte"]]
        df.to_csv(path, index=False, encoding="utf-8-sig")
        print(f"{path.name} : préambule nettoyé")


if __name__ == "__main__":
    main()
