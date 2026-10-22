#!/usr/bin/env python3
"""
Extract embeddings from ChromaDB, calculate UMAP & PCA 2D/3D projections,
and export the results to a JSON file for the React frontend to consume.

Usage:
    python scripts/export_embeddings.py
"""

import json
import re
import time
from pathlib import Path

import os
import numpy as np
import chromadb
import umap
from sklearn.decomposition import PCA
from sklearn.cluster import HDBSCAN
from langchain_core.messages import SystemMessage, HumanMessage
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import llm  # noqa: E402


ROOT_DIR = Path(__file__).parent.parent
PERSIST_DIR = ROOT_DIR / "newspaper_chroma_db"
COLLECTION_NAME = "newspaper_gabon"
FRONTEND_DIR = ROOT_DIR / "frontend"
FRONTEND_PUBLIC = FRONTEND_DIR / "public"
OUTPUT_FILE = FRONTEND_PUBLIC / "data.json"


GROUP_SIZE = 20
NAMING_PAUSE = float(os.getenv("LLM_NAMING_PAUSE", "13"))


def name_one(namer, c_id, titles, cluster_names) -> None:
    """One cluster, one call: the local model's path."""
    titles_text = "\n".join(f"- {t}" for t in titles)
    prompt = (
        "Tu es un expert en analyse de presse.\n"
        "On te donne une liste de titres d’articles d’actualité gabonaise regroupés automatiquement.\n"
        "Ta tâche est d’identifier le thème principal commun à ces titres.\n\n"

        "Règles :\n"
        "- Réponds par un seul nom de catégorie.\n"
        "- Maximum 1 à 4 mots.\n"
        "- La catégorie doit être claire, concise et explicite.\n"
        "- N'ajoute aucune explication.\n"
        "- N'écris rien d'autre que le nom de la catégorie.\n\n"

        "Exemples de catégories possibles :\n"
        "Politique, Économie, Faits Divers, Éducation, Santé, Justice, Société, Diplomatie.\n\n"

        "Titres :\n"
        f"{titles_text}\n\n"

        "Catégorie :"
    )
    try:
        msg = [SystemMessage(content="Tu es un journaliste synthétique."), HumanMessage(content=prompt)]
        name = namer.invoke(msg).content.strip().replace('"', '').replace("'", "")
        cluster_names[c_id] = name
        print(f"  Cluster {c_id} -> {name}")
    except Exception as e:
        print(f"  Error naming cluster {c_id}: {e}")
        cluster_names[c_id] = f"Cluster {c_id}"


def name_in_groups(namer, clusters, sample_titles, cluster_names) -> None:
    """Twenty clusters per call, asking for specific names that don't repeat."""
    for start in range(0, len(clusters), GROUP_SIZE):
        group = clusters[start:start + GROUP_SIZE]
        blocks = "\n\n".join(
            f"Groupe {c_id} :\n" + "\n".join(f"- {t}" for t in sample_titles(c_id, 15))
            for c_id in group)
        taken = sorted({n for c, n in cluster_names.items() if c != -1})
        prompt = (
            "Voici des groupes de titres d’articles de la presse gabonaise, "
            "regroupés automatiquement par sujet.\n\n"
            "Pour chaque groupe, donne un nom de thème de 2 à 6 mots, le plus précis possible : "
            "nomme l’affaire, l’événement, la personne, l’institution, le secteur ou le lieu qui "
            "rassemble les titres, plutôt qu’une rubrique générale comme « Économie », « Justice » "
            "ou « Sport ». Deux groupes ne doivent jamais porter le même nom.\n"
            + (f"Noms déjà attribués, à ne pas réutiliser : {', '.join(taken)}.\n" if taken else "")
            + "\nRéponds uniquement par un objet JSON qui associe le numéro de chaque groupe à son nom, "
            'par exemple {"12": "Procès de la Satram"}.\n\n'
            + blocks
        )
        names = {}
        for attempt in range(4):
            try:
                reply = namer.invoke([HumanMessage(content=prompt)]).content
                names = json.loads(re.search(r"\{.*\}", reply, re.S).group(0))
                break
            except Exception as e:
                # 429: quota for the minute; 503: the model is overloaded
                busy = any(code in str(e) for code in ("429", "RESOURCE_EXHAUSTED", "503"))
                print(f"  Groups {group[0]}–{group[-1]}, attempt {attempt + 1}: {str(e)[:120]}")
                time.sleep(65 if busy else NAMING_PAUSE)
        missed = []
        for c_id in group:
            name = str(names.get(str(c_id), "")).strip().strip('"').strip()
            if name:
                cluster_names[c_id] = name
                print(f"  Cluster {c_id} -> {name}")
            else:
                missed.append(c_id)
        if missed:
            # The hosted model gave up on these: the batch model (the local
            # one, usually) names them one by one rather than leave "Cluster N"
            print(f"  {len(missed)} clusters left to the batch model")
            fallback = llm.chat_model(temperature=0.2, batch=True)
            for c_id in missed:
                name_one(fallback, c_id, sample_titles(c_id, 40), cluster_names)
        time.sleep(NAMING_PAUSE)


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

    # Long articles are indexed as several chunks ("<id>#N"); keep only the
    # primary chunk so the map shows one point per article.
    keep = [i for i, m in enumerate(data["metadatas"]) if not m.get("chunk")]
    data = {
        "ids":        [data["ids"][i] for i in keep],
        "embeddings": [data["embeddings"][i] for i in keep],
        "metadatas":  [data["metadatas"][i] for i in keep],
        "documents":  [data["documents"][i] for i in keep],
    }

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
    # Adjust cluster parameters based on dataset size for better small-dataset performance
    min_cluster = min(15, max(3, n_samples // 5)) 
    min_samp = max(2, min_cluster // 2)
    clusterer = HDBSCAN(min_cluster_size=min_cluster, min_samples=min_samp)
    cluster_labels = clusterer.fit_predict(umap3)
    
    unique_clusters = set(cluster_labels)
    cluster_names = {}
    

    provider = llm.NAMING_PROVIDER or llm.BATCH_PROVIDER or llm.PROVIDER
    model = llm.NAMING_MODEL or llm.BATCH_MODEL or llm.MODEL
    print(f"Generating cluster names with {provider}/{model}...")
    namer = llm.naming_model(temperature=0.2)
    cluster_names[-1] = "Divers / Non-classé"
    named = [c for c in sorted(unique_clusters) if c != -1]

    def sample_titles(c_id, k):
        indices = np.where(cluster_labels == c_id)[0]
        picked = np.random.choice(indices, min(k, len(indices)), replace=False)
        return [t for t in (data["metadatas"][i].get("title", "") for i in picked) if t]

    if provider != "ollama":
        # A hosted free tier allows a few requests a minute: name the
        # clusters twenty at a time, and pace the requests
        name_in_groups(namer, named, sample_titles, cluster_names)
    else:
        for c_id in named:
            name_one(namer, c_id, sample_titles(c_id, 40), cluster_names)

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
