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
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_ollama.chat_models import ChatOllama
from langchain_ollama.embeddings import OllamaEmbeddings
from pydantic import BaseModel

ROOT_DIR = Path(__file__).parent
PERSIST_DIR = ROOT_DIR / "newspaper_chroma_db"
COLLECTION_NAME = "newspaper_gabon"
EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma")
CHAT_MODEL  = os.getenv("OLLAMA_CHAT_MODEL",  "llama3")
RELEVANCE_THRESHOLD  = float(os.getenv("RELEVANCE_THRESHOLD",  "1.5"))
TEMPORAL_WINDOW_SIZE = int(os.getenv("TEMPORAL_WINDOW_SIZE",   "25"))

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


# ── RAG helpers ───────────────────────────────────────────────────────────────

def is_temporal_query(question: str) -> bool:
    """Return True if the question asks for recent/current news."""
    system_prompt = (
        "Tu es un classificateur d'intention. "
        "Réponds uniquement par OUI ou NON. "
        "Aucun autre mot."
    )
    user_prompt = (
        "La question suivante demande-t-elle des informations récentes "
        "(actualité, aujourd'hui, récemment, dernière news, en ce moment) ?\n\n"
        f"Question : {question}\n\n"
        "Réponse :"
    )
    try:
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ]
        response = _llm.invoke(messages).content.strip().upper()
        return response.startswith("OUI") or response.startswith("YES")
    except Exception as e:
        print(f"Temporal classification error: {e}")
        return False


def get_rag_system() -> str:
    today = date.today().strftime("%d %B %Y")
    return f"""\
Tu es un assistant journalistique expert en actualités gabonaises.
Aujourd'hui, nous sommes le {today}.
Tu reçois une question d'un utilisateur et des extraits d'articles de presse récents.

Règles impératives :
- Réponds uniquement à partir des informations présentes dans les articles fournis.
- N'invente aucune information et n'utilise pas de connaissances externes.
- Si les articles ne permettent pas de répondre, dis clairement :
  "Les articles fournis ne permettent pas de répondre à cette question."
- Pour les questions sur "les news du jour", "aujourd'hui", ou l'actualité récente,
  base-toi en priorité sur les articles les plus récents.
- Si les extraits contiennent des dates différentes, privilégie les informations les plus récentes.
- Si plusieurs articles apportent des informations complémentaires, combine-les de manière cohérente.

Rédaction :
- Rédige une réponse synthétique, fluide et bien structurée en français.
- Sois factuel, objectif et concis (4 à 7 phrases).
- Ne liste pas les sources et ne mentionne pas les documents (ils sont affichés séparément).
"""


def build_rag_prompt(question: str, articles: list[dict]) -> str:
    """Build the user-turn prompt containing article context and the question.

    The model persona is already set in the system message (get_rag_system),
    so this prompt focuses solely on context, rules, and the question.
    """
    context_blocks = []
    for i, art in enumerate(articles, 1):
        full_text = art.get("full_text", art["snippet"])
        block = (
            f"[Article {i}]\n"
            f"Titre : {art['title']}\n"
            f"Date  : {art['date']}\n"
            f"Source: {art['source']}\n\n"
            f"{full_text[:2500]}"
        )
        context_blocks.append(block)

    context = "\n\n---------------------\n\n".join(context_blocks)

    return (
        "RÈGLES STRICTES :\n"
        "- Utilise uniquement les informations présentes dans les articles.\n"
        "- N'invente aucune information.\n"
        "- N'utilise pas de connaissances extérieures.\n"
        "- Si la réponse n'est pas explicitement dans les articles, résume ce qui est mentionné "
        "(ex: 'Les articles mentionnent que X a fait Y le [date]').\n"
        "- Si vraiment aucune information n'est présente, répond exactement : "
        "'Les articles fournis ne contiennent pas cette information.'\n"
        "- Combine les informations de tous les articles pertinents.\n"
        "- Privilégie les faits les plus récents.\n\n"

        "STYLE :\n"
        "- Réponse journalistique claire, factuelle et structurée.\n"
        "- 4 à 8 phrases.\n"
        "- Ne mentionne pas les numéros d'articles.\n\n"

        f"=== ARTICLES ===\n{context}\n=== FIN ARTICLES ===\n\n"
        f"Question : {question}\n\n"
        "Réponse :"
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


# ── Constants ─────────────────────────────────────────────────────────────────

# Kept specific to avoid false positives on substrings like
# "aucune information contradictoire" or "pas d'informations supplémentaires".
NO_ANSWER_MARKERS = [
    "ne contiennent pas cette information",
    "ne contiennent pas d'information",
    "ne permettent pas de répondre",
    "je ne dispose pas",
    "pas en mesure de répondre",
]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    # Peek at the most recent article date in the collection
    sample = _collection.get(limit=1, include=["metadatas"])
    last_date = None
    if sample and sample["metadatas"]:
        # Get actual most recent by querying with a sort — or just expose count
        pass
    return {
        "status": "ok",
        "articles": _collection.count(),
        "llm": CHAT_MODEL,
        "last_article_date": last_date,  # hook up your scraper's metadata here
    }

@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest):
    # 1. Classify query intent once — result reused below
    is_temporal = is_temporal_query(req.question)

    # 2. Embed question
    q_vec = _embedder.embed_query(req.question)

    # 3. Retrieve candidates from ChromaDB
    n_fetch = 80 if is_temporal else 30
    raw = _collection.query(
        query_embeddings=[q_vec],
        n_results=n_fetch,
        include=["documents", "metadatas", "distances"],
    )

    combined = list(zip(raw["metadatas"][0], raw["distances"][0], raw["documents"][0]))

    # 4. Filter / sort
    if is_temporal:
        # Sort by most recent, then give the LLM a wide window so it can
        # produce a meaningful "news of the day" summary even when the top
        # articles cover varied topics.
        combined.sort(key=lambda x: x[0].get("published_time", ""), reverse=True)
        combined = combined[:TEMPORAL_WINDOW_SIZE]
    else:
        combined = [
            (m, d, doc) for m, d, doc in combined if d < RELEVANCE_THRESHOLD
        ][:15]

    articles: list[ArticleResult] = []
    article_dicts: list[dict] = []

    for meta, dist, doc in combined:
        snippet = doc[:400] + "..." if len(doc) > 400 else doc
        article_dicts.append({
            "title":     meta.get("title", ""),
            "date":      meta.get("published_time", "")[:10],
            "source":    meta.get("source", ""),
            "snippet":   snippet,
            "full_text": doc,
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

    # 5. Generate answer with LLM (only if we have relevant articles)
    if not article_dicts:
        answer = "Aucun article pertinent n'a été trouvé pour cette recherche."
    else:
        messages = [
            SystemMessage(content=get_rag_system()),
            HumanMessage(content=build_rag_prompt(req.question, article_dicts)),
        ]
        answer = _llm.invoke(messages).content.strip()

        # If the LLM signals it cannot answer, hide the source articles
        if any(marker in answer.lower() for marker in NO_ANSWER_MARKERS):
            articles = []

    return SearchResponse(question=req.question, answer=answer, results=articles)


if __name__ == "__main__":
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=False)
