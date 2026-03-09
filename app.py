import os
import argparse
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st
import chromadb
import umap
from sklearn.decomposition import PCA
from langchain_ollama.embeddings import OllamaEmbeddings

# Must be the first Streamlit command
st.set_page_config(page_title="Gabon Media Explorer", layout="wide")

# Paths
PERSIST_DIR = str(Path(__file__).parent / "newspaper_chroma_db")
COLLECTION_NAME = "newspaper_gabon"

# ─── caching data loading to make the app fast ───
@st.cache_resource
def load_db_data():
    client = chromadb.PersistentClient(path=PERSIST_DIR)
    collection = client.get_collection(name=COLLECTION_NAME)
    data = collection.get(include=["embeddings", "metadatas", "documents"])
    return data

@st.cache_resource
def get_embedding_model():
    model_name = os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma")
    return OllamaEmbeddings(model=model_name)

@st.cache_data
def process_data(_data):
    """Process chroma data into a clean dataframe"""
    categories = [meta.get("category", "unknown") for meta in _data["metadatas"]]
    titles     = [meta.get("title", "")[:80] for meta in _data["metadatas"]]
    dates      = [meta.get("published_time", "")[:10] for meta in _data["metadatas"]]
    sources    = [meta.get("source", "unknown") for meta in _data["metadatas"]]
    
    # Wrap long text for hover display
    documents = [
        "<br>".join(doc[i:i+80] for i in range(0, min(len(doc), 400), 80))
        for doc in _data["documents"]
    ]
    
    X = np.array(_data["embeddings"], dtype=np.float32)
    
    return X, categories, titles, dates, sources, documents


# ─── app layout ───
st.title("📰 Gabon Media Explorer")
st.markdown("Visualisez la distribution thématique des articles issus de **GabonReview** et **GabonMediaTime**.")

# Sidebar controls
st.sidebar.header("Paramètres")
proj_method = st.sidebar.radio("Méthode de projection", ["UMAP", "PCA"])
dimensions = st.sidebar.radio("Dimensions", ["2D", "3D"])
color_by = st.sidebar.selectbox("Colorer les points par :", ["Catégorie", "Source"])

st.sidebar.markdown("---")
st.sidebar.subheader("🔍 Ajouter une requête")
user_query = st.sidebar.text_input("Posez une question pour voir où elle se situe :", value="Que dit l'opposition sur la transition?")

# Load data
with st.spinner("Chargement de la base de données (ChromaDB)..."):
    try:
        data = load_db_data()
        X, categories, titles, dates, sources, documents = process_data(data)
    except Exception as e:
        st.error(f"Erreur lors du chargement de ChromaDB. Avez-vous exécuté le scraper ?\n\n{e}")
        st.stop()


# ─── Projection & Plotting ───
@st.cache_resource
def compute_projection(method, dims, _X):
    n_comp = 2 if dims == "2D" else 3
    if method == "UMAP":
        model = umap.UMAP(
            n_components=n_comp,
            n_neighbors=min(15, len(_X) - 1),
            min_dist=0.1,
            metric="cosine",
            random_state=42
        )
        xy = model.fit_transform(_X)
    else:
        model = PCA(n_components=n_comp, random_state=42)
        xy = model.fit_transform(_X)
    return model, xy


with st.spinner(f"Calcul de la projection {proj_method} {dimensions}..."):
    model, xy = compute_projection(proj_method, dimensions, X)

# Prepare DataFrame for Plotly
df_plot = pd.DataFrame(xy, columns=[f"D1", f"D2"] + ([f"D3"] if dimensions == "3D" else []))
df_plot["category"] = categories
df_plot["source"]   = sources
df_plot["title"]    = titles
df_plot["date"]     = dates
df_plot["document"] = documents

color_col = "category" if color_by == "Catégorie" else "source"

# Plot Articles
if dimensions == "2D":
    fig = px.scatter(
        df_plot, x="D1", y="D2", color=color_col,
        hover_data=["title", "date", "source", "document"],
        title=f"{proj_method} 2D — Articles de presse",
        height=700
    )
    fig.update_traces(marker=dict(size=8, opacity=0.85))
else:
    fig = px.scatter_3d(
        df_plot, x="D1", y="D2", z="D3", color=color_col,
        hover_data=["title", "date", "source", "document"],
        title=f"{proj_method} 3D — Articles de presse",
        height=800
    )
    fig.update_traces(marker=dict(size=4, opacity=0.85))

# Project Query Point
if user_query:
    with st.spinner("Encodage de la requête via Ollama..."):
        emb_model = get_embedding_model()
        q_emb = np.array(emb_model.embed_query(user_query), dtype=np.float32).reshape(1, -1)
        q_xy = model.transform(q_emb)[0]
        
    # Add Query point to plot
    if dimensions == "2D":
        fig.add_trace(go.Scatter(
            x=[q_xy[0]], y=[q_xy[1]],
            mode="markers+text", text=["Requête"], textposition="top center",
            marker=dict(size=14, symbol="x", color="black"),
            name="Requête", hovertext=[user_query], hoverinfo="text"
        ))
    else:
        fig.add_trace(go.Scatter3d(
            x=[q_xy[0]], y=[q_xy[1]], z=[q_xy[2]],
            mode="markers+text", text=["Requête"], textposition="top center",
            marker=dict(size=8, symbol="x", color="black"),
            name="Requête", hovertext=[user_query], hoverinfo="text"
        ))

st.plotly_chart(fig, use_container_width=True)

st.markdown("---")
st.markdown(f"**Statistiques:** `{len(X)}` articles au total.")
