#!/usr/bin/env python3
"""
Lightweight FastAPI server providing a RAG search endpoint.

Embeds the user's question using Ollama (embeddinggemma) and returns the
top-K closest articles from the ChromaDB newspaper collection.

Usage:
    .venv/bin/python api.py          # runs on http://localhost:8000
"""

import os
from pathlib import Path

import chromadb
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langchain_ollama.embeddings import OllamaEmbeddings
from pydantic import BaseModel

ROOT_DIR = Path(__file__).parent
PERSIST_DIR = ROOT_DIR / "newspaper_chroma_db"
COLLECTION_NAME = "newspaper_gabon"
EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma")

app = FastAPI(title="Gabon Media RAG API")

# Allow the React dev server (and any origin) to call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load ChromaDB collection once at startup
print(f"Loading ChromaDB from {PERSIST_DIR}...")
_client = chromadb.PersistentClient(path=str(PERSIST_DIR))
_collection = _client.get_collection(COLLECTION_NAME)
print(f"  ✅ {_collection.count()} articles ready.")

_embedder = OllamaEmbeddings(model=EMBED_MODEL)


# ── Request / Response Schemas ────────────────────────────────────────────────

class SearchRequest(BaseModel):
    question: str
    n_results: int = 5


class ArticleResult(BaseModel):
    title: str
    date: str
    source: str
    category: str
    url: str
    snippet: str
    distance: float


class SearchResponse(BaseModel):
    question: str
    results: list[ArticleResult]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "articles": _collection.count()}


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest):
    # Embed the user question
    q_vec = _embedder.embed_query(req.question)

    # Query ChromaDB
    results = _collection.query(
        query_embeddings=[q_vec],
        n_results=req.n_results,
        include=["documents", "metadatas", "distances"],
    )

    articles: list[ArticleResult] = []
    for meta, dist, doc in zip(
        results["metadatas"][0],
        results["distances"][0],
        results["documents"][0],
    ):
        snippet = doc[:300] + "..." if len(doc) > 300 else doc
        articles.append(
            ArticleResult(
                title    = meta.get("title", ""),
                date     = meta.get("published_time", "")[:10],
                source   = meta.get("source", ""),
                category = meta.get("category", ""),
                url      = meta.get("source_url", ""),
                snippet  = snippet,
                distance = round(dist, 4),
            )
        )

    return SearchResponse(question=req.question, results=articles)


if __name__ == "__main__":
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=False)
