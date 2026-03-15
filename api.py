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
EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma") #embeddinggemma
CHAT_MODEL  = os.getenv("OLLAMA_CHAT_MODEL", "llama3") #llama3

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

def is_temporal_query(question: str) -> bool:
    """Return True if the question asks for recent/current news."""

    from langchain_core.messages import SystemMessage, HumanMessage

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
            HumanMessage(content=user_prompt)
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
- Pour les questions sur "les news du jour", "aujourd'hui", ou l'actualité récente, base-toi en priorité sur les articles les plus récents.
- Si les extraits contiennent des dates différentes, privilégie les informations les plus récentes.
- Si plusieurs articles apportent des informations complémentaires, combine-les de manière cohérente.

Rédaction :
- Rédige une réponse synthétique, fluide et bien structurée en français.
- Sois factuel, objectif et concis (4 à 7 phrases).
- Ne liste pas les sources et ne mentionne pas les documents (ils sont affichés séparément).
"""

def build_rag_prompt(question: str, articles: list[dict]) -> str:
    context_blocks = []

    for i, art in enumerate(articles, 1):
        full_text = art.get("full_text", art["snippet"])
        text_for_llm = full_text[:2500]

        block = (
            f"[Article {i}]\n"
            f"Titre : {art['title']}\n"
            f"Date : {art['date']}\n"
            f"Source : {art['source']}\n\n"
            f"{text_for_llm}"
        )

        context_blocks.append(block)

    context = "\n\n---------------------\n\n".join(context_blocks)

    return (
        "Tu es l'assistant journalistique du média 'Kiosque Gabonais'.\n\n"

        "MISSION :\n"
        "Répondre à la question de l'utilisateur en utilisant uniquement les informations "
        "présentes dans les articles fournis.\n\n"

        "RÈGLES STRICTES :\n"
        "- Utilise uniquement les informations présentes dans les articles.\n"
        "- N'invente aucune information.\n"
        "- N'utilise pas de connaissances extérieures.\n"
        "- Si la réponse n'est pas dans les articles, répond exactement : "
        "'Les articles fournis ne contiennent pas cette information.'\n"
        "- Si plusieurs articles contiennent des informations pertinentes, combine-les.\n"
        "- Si les articles ont des dates différentes, privilégie les informations les plus récentes.\n"
        "- Utilise les noms, chiffres et faits présents dans les articles.\n\n"

        "STYLE :\n"
        "- Réponse journalistique claire et factuelle.\n"
        "- 4 à 6 phrases maximum.\n"
        "- Pas de liste.\n"
        "- Ne mentionne pas les sources ni les numéros d'articles.\n\n"

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


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "articles": _collection.count(), "llm": CHAT_MODEL}


@app.post("/search", response_model=SearchResponse)
def search(req: SearchRequest):
    # 1. Embed question
    q_vec = _embedder.embed_query(req.question)

    # 2. Retrieve candidates — fetch a larger pool to filter by relevance
    n_fetch = 80 if is_temporal_query(req.question) else 15
    
    collection = _client.get_collection(COLLECTION_NAME)
    
    raw = collection.query(
        query_embeddings=[q_vec],
        n_results=n_fetch,
        include=["documents", "metadatas", "distances"],
    )

    combined = list(zip(raw["metadatas"][0], raw["distances"][0], raw["documents"][0]))

    # For temporal queries, re-sort by date (most recent first)
    if is_temporal_query(req.question):
        combined.sort(key=lambda x: x[0].get("published_time", ""), reverse=True)
        combined = combined[:req.n_results]
    else:
        # Keep only articles with good relevance (distance < 1.2), cap at 10
        RELEVANCE_THRESHOLD = 1.2
        combined = [(m, d, doc) for m, d, doc in combined if d < RELEVANCE_THRESHOLD]
        combined = combined[:10]

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

    # 3. Generate answer with LLM (only if we have relevant articles)
    if not article_dicts:
        answer = "Aucun article pertinent n'a été trouvé pour cette recherche."
    else:
        from langchain_core.messages import SystemMessage, HumanMessage
        messages = [
            SystemMessage(content=get_rag_system()),
            HumanMessage(content=build_rag_prompt(req.question, article_dicts)),
        ]
        answer = _llm.invoke(messages).content.strip()

        # If the LLM says it can't answer, don't show sources
        NO_ANSWER_MARKERS = [
            "ne contiennent pas cette information",
            "ne contiennent pas d'information",
            "pas d'informations",
            "aucune information",
            "ne permettent pas de répondre",
            "je ne dispose pas",
            "pas en mesure de répondre",
        ]
        if any(marker in answer.lower() for marker in NO_ANSWER_MARKERS):
            articles = []

    return SearchResponse(question=req.question, answer=answer, results=articles)


if __name__ == "__main__":
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=False)
