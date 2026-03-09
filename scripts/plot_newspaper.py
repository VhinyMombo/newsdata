"""
UMAP 2D visualisation of newspaper article embeddings from ChromaDB.
Colored by category, with an interactive query point.

Usage:
    python scripts/plot_newspaper.py
    python scripts/plot_newspaper.py --question "Que dit l'opposition?"
"""

from pathlib import Path
import os
import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import chromadb
import umap
from langchain_ollama.embeddings import OllamaEmbeddings

PERSIST_DIR = str(Path(__file__).parent.parent / "newspaper_chroma_db")
COLLECTION_NAME = "newspaper_gabon"

# ── Load data from Chroma ──────────────────────────────────────────────
client = chromadb.PersistentClient(path=PERSIST_DIR)
collection = client.get_collection(name=COLLECTION_NAME)

data = collection.get(include=["embeddings", "metadatas", "documents"])

categories = [meta.get("category", "unknown") for meta in data["metadatas"]]
titles     = [meta.get("title", "")[:80] for meta in data["metadatas"]]
dates      = [meta.get("published_time", "")[:10] for meta in data["metadatas"]]

# Wrap long text for hover display
documents = [
    "<br>".join(doc[i:i+80] for i in range(0, min(len(doc), 400), 80))
    for doc in data["documents"]
]

X = np.array(data["embeddings"], dtype=np.float32)

# ── UMAP 2D ────────────────────────────────────────────────────────────
umap_model = umap.UMAP(
    n_components=2,
    n_neighbors=min(15, len(X) - 1),  # handle small datasets
    min_dist=0.1,
    metric="cosine",
    random_state=42,
)

xy = umap_model.fit_transform(X)

df = pd.DataFrame(xy, columns=["UMAP1", "UMAP2"])
df["category"] = categories
df["title"]    = titles
df["date"]     = dates
df["document"] = documents

fig = px.scatter(
    df,
    x="UMAP1",
    y="UMAP2",
    color="category",
    hover_data=["title", "date", "document"],
    title="UMAP 2D — Articles GabonReview/MediaTime par catégorie",
)
fig.update_traces(marker=dict(size=8, opacity=0.85))
fig.show()

# ── Query projection ──────────────────────────────────────────────────
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--question", type=str, default="Que dit l'opposition sur la transition?")
args, _ = parser.parse_known_args()

embedding = OllamaEmbeddings(model=os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma"))
q_emb = np.array(embedding.embed_query(args.question), dtype=np.float32).reshape(1, -1)
q_xy = umap_model.transform(q_emb)[0]

fig.add_trace(
    go.Scatter(
        x=[q_xy[0]],
        y=[q_xy[1]],
        mode="markers+text",
        text=["QUERY"],
        textposition="top center",
        marker=dict(size=14, symbol="x", color="black"),
        name="query",
        hovertext=[args.question],
        hoverinfo="text",
    )
)

fig.update_layout(
    title="UMAP 2D — Articles GabonReview/MediaTime + requête",
    xaxis_title="UMAP1",
    yaxis_title="UMAP2",
)
fig.show()
