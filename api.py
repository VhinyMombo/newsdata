#!/usr/bin/env python3
"""
Lightweight FastAPI server providing a RAG search + answer endpoint.

Embeds the user's question, retrieves the top-K articles from ChromaDB,
then generates a synthesised answer using a local Ollama LLM.

Usage:
    .venv/bin/python api.py          # runs on http://localhost:8000
"""

import os
from datetime import date
from pathlib import Path

import chromadb
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langchain_ollama.chat_models import ChatOllama
from langchain_ollama.embeddings import OllamaEmbeddings
from pydantic import BaseModel

ROOT_DIR = Path(__file__).parent
PERSIST_DIR = ROOT_DIR / "newspaper_chroma_db"
COLLECTION_NAME = "newspaper_gabon"
EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma")
CHAT_MODEL  = os.getenv("OLLAMA_CHAT_MODEL", "llama3")

app = FastAPI(title="Gabon Media RAG API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load resources once at startup
print(f"Loading ChromaDB from {PERSIST_DIR}...")
_client     = chromadb.PersistentClient(path=str(PERSIST_DIR))
_collection = _client.get_collection(COLLECTION_NAME)
_embedder   = OllamaEmbeddings(model=EMBED_MODEL)
_llm        = ChatOllama(model=CHAT_MODEL, temperature=0.2)
print(f"  ✅ {_collection.count()} articles ready  |  LLM: {CHAT_MODEL}")


# ── RAG Prompt ────────────────────────────────────────────────────────────────

TEMPORAL_KEYWORDS = [
    "aujourd'hui", "du jour", "ce soir", "cette semaine", "ce mois",
    "récent", "dernier", "dernière", "maintenant", "actuellement", "news", "latest"
]

def is_temporal_query(question: str) -> bool:
    q = question.lower()
    return any(kw in q for kw in TEMPORAL_KEYWORDS)


def get_rag_system() -> str:
    today = date.today().strftime("%d %B %Y")
    return f"""\
Tu es un assistant journalistique expert en actualités gabonaises.
Aujourd'hui, nous sommes le {today}.
Tu reçois une question d'un utilisateur et des extraits d'articles de presse récents.

Règles impératives :
- Réponds uniquement à partir des informations présentes dans les articles fournis.
- Si les articles ne permettent pas de répondre, dis-le clairement.
- Pour les questions sur "les news du jour" ou "aujourd'hui", base-toi en priorité sur les articles les plus récents.
- Rédige une réponse synthétique, fluide et bien structurée en français.
- Ne liste pas les sources (elles sont affichées séparément).
- Sois factuel, objectif et concis (4 à 7 phrases).
"""

def build_rag_prompt(question: str, articles: list[dict]) -> str:
    context_blocks = []
    for i, art in enumerate(articles, 1):
        block = (
            f"[Article {i}] {art['title']} ({art['date']}, {art['source']})\n"
            f"{art['snippet'][:400]}"
        )
        context_blocks.append(block)

    context = "\n\n".join(context_blocks)
    return (
        f"Contexte — articles de presse récents :\n\n{context}\n\n"
        f"Question : {question}\n\n"
        f"Réponds en te basant uniquement sur les articles ci-dessus."
    )


# ── Schemas ───────────────────────────────────────────────────────────────────

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
    answer: str
    results: list[ArticleResult]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "articles": _collection.count(), "llm": CHAT_MODEL}


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest):
    # 1. Embed question
    q_vec = _embedder.embed_query(req.question)

    # 2. Retrieve top-K articles — fetch more for temporal queries
    n_fetch = max(req.n_results * 3, 15) if is_temporal_query(req.question) else req.n_results
    raw = _collection.query(
        query_embeddings=[q_vec],
        n_results=n_fetch,
        include=["documents", "metadatas", "distances"],
    )

    combined = list(zip(raw["metadatas"][0], raw["distances"][0], raw["documents"][0]))

    # For temporal queries, re-sort by date (most recent first), then take top-K
    if is_temporal_query(req.question):
        combined.sort(key=lambda x: x[0].get("published_time", ""), reverse=True)
    combined = combined[:req.n_results]

    articles: list[ArticleResult] = []
    article_dicts: list[dict] = []

    for meta, dist, doc in combined:
        snippet = doc[:400] + "..." if len(doc) > 400 else doc
        article_dicts.append({
            "title":   meta.get("title", ""),
            "date":    meta.get("published_time", "")[:10],
            "source":  meta.get("source", ""),
            "snippet": snippet,
        })
        articles.append(ArticleResult(
            title    = meta.get("title", ""),
            date     = meta.get("published_time", "")[:10],
            source   = meta.get("source", ""),
            category = meta.get("category", ""),
            url      = meta.get("source_url", ""),
            snippet  = snippet,
            distance = round(dist, 4),
        ))

    # 3. Generate answer with LLM
    from langchain_core.messages import SystemMessage, HumanMessage
    messages = [
        SystemMessage(content=get_rag_system()),
        HumanMessage(content=build_rag_prompt(req.question, article_dicts)),
    ]
    answer = _llm.invoke(messages).content.strip()

    return SearchResponse(question=req.question, answer=answer, results=articles)


if __name__ == "__main__":
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=False)
