#!/usr/bin/env python3
"""
Extract embeddings from ChromaDB, calculate UMAP & PCA 2D/3D projections,
and export the results to a JSON file for the React frontend to consume.

Usage:
    python scripts/export_embeddings.py
"""

import json
from pathlib import Path

import numpy as np
import chromadb
import umap
from sklearn.decomposition import PCA

ROOT_DIR = Path(__file__).parent.parent
PERSIST_DIR = ROOT_DIR / "newspaper_chroma_db"
COLLECTION_NAME = "newspaper_gabon"
FRONTEND_DIR = ROOT_DIR / "frontend"
FRONTEND_PUBLIC = FRONTEND_DIR / "public"
OUTPUT_FILE = FRONTEND_PUBLIC / "data.json"


def main() -> None:
    if not PERSIST_DIR.exists():
        print(f"❌ Error: Database not found at {PERSIST_DIR}")
        print("   Please run the web scraper pipeline first.")
        return

    # Ensure frontend directories exist to write the JSON to
    FRONTEND_PUBLIC.mkdir(parents=True, exist_ok=True)

    print(f"Loading ChromaDB from {PERSIST_DIR}...")
    client = chromadb.PersistentClient(path=str(PERSIST_DIR))
    collection = client.get_collection(name=COLLECTION_NAME)
    
    data = collection.get(include=["embeddings", "metadatas", "documents"])
    
    if len(data["embeddings"]) == 0:
        print("❌ Error: No embeddings found in collection.")
        return
        
    X = np.array(data["embeddings"], dtype=np.float32)
    n_samples = len(X)
    print(f"Loaded {n_samples} embeddings.")

    # ---------------------------------------------------------
    # Projections
    # ---------------------------------------------------------
    print("Computing PCA (2D & 3D)...")
    pca2 = PCA(n_components=2, random_state=42).fit_transform(X)
    pca3 = PCA(n_components=3, random_state=42).fit_transform(X)

    print("Computing UMAP (2D & 3D)...")
    umap2 = umap.UMAP(n_components=2, min_dist=0.1, n_neighbors=min(15, n_samples-1), metric="cosine", random_state=42).fit_transform(X)
    umap3 = umap.UMAP(n_components=3, min_dist=0.1, n_neighbors=min(15, n_samples-1), metric="cosine", random_state=42).fit_transform(X)

    # ---------------------------------------------------------
    # Assemble JSON Payload
    # ---------------------------------------------------------
    print("Formatting data for export...")
    export_data = {
        "metadata": {
            "total_articles": n_samples
        },
        "points": []
    }

    for i in range(n_samples):
        meta = data["metadatas"][i]
        
        # Format document snippet for hover tooltips
        doc = data["documents"][i]
        doc_snippet = "<br>".join(doc[j:j+80] for j in range(0, min(len(doc), 400), 80))
        if len(doc) > 400:
            doc_snippet += "..."
            
        point = {
            "id": data["ids"][i],
            "title": meta.get("title", ""),
            "date": meta.get("published_time", "")[:10],
            "category": meta.get("category", "unknown"),
            "source": meta.get("source", "unknown"),
            "url": meta.get("source_url", ""),
            "snippet": doc_snippet,
            "projections": {
                "PCA_2D": [float(pca2[i][0]), float(pca2[i][1])],
                "PCA_3D": [float(pca3[i][0]), float(pca3[i][1]), float(pca3[i][2])],
                "UMAP_2D": [float(umap2[i][0]), float(umap2[i][1])],
                "UMAP_3D": [float(umap3[i][0]), float(umap3[i][1]), float(umap3[i][2])]
            }
        }
        export_data["points"].append(point)

    print(f"Writing to {OUTPUT_FILE}...")
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(export_data, f, ensure_ascii=False)
        
    print("✅ Export complete!")


if __name__ == "__main__":
    main()
