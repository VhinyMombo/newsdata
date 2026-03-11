#!/usr/bin/env python3
"""
Extract embeddings from ChromaDB, calculate UMAP & PCA 2D/3D projections,
and export the results to a JSON file for the React frontend to consume.

Usage:
    python scripts/export_embeddings.py
"""

import json
from pathlib import Path

import os
import numpy as np
import chromadb
import umap
from sklearn.decomposition import PCA
from sklearn.cluster import HDBSCAN
from langchain_core.messages import SystemMessage, HumanMessage
from langchain_ollama.chat_models import ChatOllama


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
    # Clustering (HDBSCAN on UMAP 3D) & LLM Naming
    # ---------------------------------------------------------
    print("Computing HDBSCAN clustering on UMAP 3D...")
    clusterer = HDBSCAN(min_cluster_size=15, min_samples=10)
    cluster_labels = clusterer.fit_predict(umap3)
    
    unique_clusters = set(cluster_labels)
    cluster_names = {}
    
    print("Generating cluster names with Llama3...")
    llm = ChatOllama(model=os.getenv('OLLAMA_CHAT_MODEL', 'llama3'), temperature=0.0)
    
    for c_id in unique_clusters:
        if c_id == -1:
            cluster_names[c_id] = "Divers / Non-classé"
            continue
            
        # Get up to 40 random titles from this cluster to prompt the LLM
        indices = np.where(cluster_labels == c_id)[0]
        sample_indices = np.random.choice(indices, min(40, len(indices)), replace=False)
        sample_titles = [data["metadatas"][idx].get("title", "") for idx in sample_indices]
        titles_text = "\n".join(f"- {t}" for t in sample_titles if t)
        
        prompt = (
            "Voici une liste de titres d'articles d'actualité gabonaise qui ont été regroupés par une IA.\n"
            "Déduis le thème ou le sujet principal commun à ces articles.\n"
            "Réponds UNIQUEMENT par un nom court, explicite et percutant de 1 à 4 mots maximum (ex: 'Politique Économique', 'Faits Divers', 'Éducation Nationale').\n"
            "Ne justifie pas ta réponse, donne uniquement le nom de la catégorie.\n\n"
            f"Titres :\n{titles_text}"
        )
        
        try:
            msg = [SystemMessage(content="Tu es un journaliste synthétique."), HumanMessage(content=prompt)]
            name = llm.invoke(msg).content.strip().replace('"', '').replace("'", "")
            cluster_names[c_id] = name
            print(f"  Cluster {c_id} ({len(indices)} articles) -> {name}")
        except Exception as e:
            print(f"  Error naming cluster {c_id}: {e}")
            cluster_names[c_id] = f"Cluster {c_id}"

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
            
        c_id = cluster_labels[i]
            
        point = {
            "id": data["ids"][i],
            "title": meta.get("title", ""),
            "date": meta.get("published_time", "")[:10],
            "category": meta.get("category", "unknown"),
            "source": meta.get("source", "unknown"),
            "cluster_name": cluster_names[c_id],
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
