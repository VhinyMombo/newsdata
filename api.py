#!/usr/bin/env python3
"""
Lightweight FastAPI server providing a RAG search + answer endpoint.

Embeds the user's question, retrieves the top-K articles from ChromaDB,
then generates a synthesised answer using a local Ollama LLM.

Usage:
    .venv/bin/python api.py          # runs on http://localhost:8000
"""

import logging
import math
import os
import re
import time
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import chromadb
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_ollama.chat_models import ChatOllama
from langchain_ollama.embeddings import OllamaEmbeddings
from pydantic import BaseModel, Field

ROOT_DIR = Path(__file__).parent
PERSIST_DIR = ROOT_DIR / "newspaper_chroma_db"
COLLECTION_NAME = "newspaper_gabon"
CODES_PERSIST_DIR = ROOT_DIR / "codes_chroma_db"
CODES_COLLECTION_NAME = "codes_gabon"
EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma")
CHAT_MODEL  = os.getenv("OLLAMA_CHAT_MODEL",  "qwen3.5:9b")
OLLAMA_URL  = os.getenv("OLLAMA_HOST", "http://localhost:11434")
RELEVANCE_THRESHOLD  = float(os.getenv("RELEVANCE_THRESHOLD",  "1.7"))
# Legal queries are phrased farther from statute wording — slightly looser cutoff
CODES_RELEVANCE_THRESHOLD = float(os.getenv("CODES_RELEVANCE_THRESHOLD", "1.9"))
# Temporal ranking: score = SIMILARITY_WEIGHT * similarity + RECENCY_WEIGHT * decay,
# where decay halves every RECENCY_HALF_LIFE_DAYS.
SIMILARITY_WEIGHT      = float(os.getenv("SIMILARITY_WEIGHT",      "0.6"))
RECENCY_WEIGHT         = float(os.getenv("RECENCY_WEIGHT",         "0.4"))
RECENCY_HALF_LIFE_DAYS = float(os.getenv("RECENCY_HALF_LIFE_DAYS", "2.0"))
# Candidates fetched inside a time window before ranking
TEMPORAL_FETCH_K       = int(os.getenv("TEMPORAL_FETCH_K", "100"))
# Non-temporal queries get a mild recency nudge too: on evolving topics
# (dette, nominations…) an older in-depth article often embeds closer than
# yesterday's update, so pure similarity feeds the LLM stale figures.
# Similarity stays dominant and the decay is slow — a relevant old article
# still beats a barely-relevant fresh one.
NONTEMPORAL_SIM_WEIGHT      = float(os.getenv("NONTEMPORAL_SIM_WEIGHT",      "0.85"))
NONTEMPORAL_REC_WEIGHT      = float(os.getenv("NONTEMPORAL_REC_WEIGHT",      "0.15"))
NONTEMPORAL_HALF_LIFE_DAYS  = float(os.getenv("NONTEMPORAL_HALF_LIFE_DAYS",  "45"))
# Max characters of each article passed to the LLM for answer generation
ANSWER_EXCERPT_CHARS = int(os.getenv("ANSWER_EXCERPT_CHARS", "4000"))
# Ollama context window for the chat model (must fit system + 5 articles + question)
CHAT_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "16384"))

# Gabon has a single fixed offset year-round (WAT, UTC+1, no DST). All "what
# day is it" logic below (temporal RAG windows, daily report boundaries,
# "today" prompts) must anchor on Gabon civil time, not the server's system
# clock — a server running one timezone east (e.g. CEST, UTC+2, common on a
# European dev machine) sees midnight an hour before Gabon does, so during
# that hour it silently answers "today" questions as if it were tomorrow.
GABON_TZ = ZoneInfo("Africa/Libreville")


def gabon_now() -> datetime:
    """Current Gabon wall-clock time, as a naive datetime (tzinfo stripped)
    so it stays comparable with the naive dates/timestamps already stored
    from scraping — only the *reference point* changes, not the data shape."""
    return datetime.now(GABON_TZ).replace(tzinfo=None)


def gabon_today() -> date:
    return gabon_now().date()


def gabon_timestamp(dt: datetime) -> float:
    """Unix epoch for a naive datetime that represents Gabon wall-clock time.

    Plain `naive_dt.timestamp()` assumes the *system's* local timezone for
    the conversion — on a server one hour east of Gabon (e.g. CEST), that
    would silently shift every computed epoch by an hour, undoing the point
    of gabon_now() right at the last step. Re-attach the real timezone first.
    """
    return dt.replace(tzinfo=GABON_TZ).timestamp()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("rag-api")

app = FastAPI(title="Le Kiosque API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _client_ip(request: Request) -> str:
    """Rate-limit key: behind the Vite proxy every request arrives from
    127.0.0.1, so trust the tunnel/proxy headers before the socket address."""
    return (
        request.headers.get("cf-connecting-ip")
        or (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        or get_remote_address(request)
    )


# LLM endpoints monopolize the machine for ~10 s per call: cap them per
# client so one visitor cannot pin the host CPU/GPU indefinitely
limiter = Limiter(key_func=_client_ip)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Load resources once at startup
logger.info(f"Loading ChromaDB from {PERSIST_DIR}...")
_client     = chromadb.PersistentClient(path=str(PERSIST_DIR))
_collection = _client.get_collection(COLLECTION_NAME)
_embedder   = OllamaEmbeddings(model=EMBED_MODEL)
# Reasoning models (Qwen3, DeepSeek-R1…) think in hidden tokens before answering,
# which multiplies generation time — off by default, RAG synthesis rarely needs it.
# Set OLLAMA_REASONING=true to enable thinking on models that support it.
_REASONING_MODEL_PREFIXES = ("qwen3", "deepseek-r1", "magistral", "gpt-oss")
REASONING_ENABLED = os.getenv("OLLAMA_REASONING", "false").lower() == "true"
_llm = ChatOllama(
    model=CHAT_MODEL,
    temperature=0.2,
    num_ctx=CHAT_NUM_CTX,
    **({"reasoning": REASONING_ENABLED}
       if CHAT_MODEL.lower().startswith(_REASONING_MODEL_PREFIXES) else {}),
)
logger.info(f"✅ {_collection.count()} articles ready  |  LLM: {CHAT_MODEL}")

# Legal codes corpus (optional second collection — same embedding model)
try:
    _codes_collection = chromadb.PersistentClient(
        path=str(CODES_PERSIST_DIR)
    ).get_collection(CODES_COLLECTION_NAME)
    logger.info(f"⚖️  {_codes_collection.count()} articles de codes juridiques ready")
except Exception as e:
    _codes_collection = None
    logger.warning(f"Codes juridiques indisponibles ({e}) — corpus 'codes' désactivé")

CODE_LABELS = {
    "codes_minier":         "Code minier",
    "codes_penal":          "Code pénal",
    "codes_penal_modifie":  "Code pénal (modifié)",
    "codes_enfants":        "Code de l'enfant",
    "codes_hydrocarbures":  "Code des hydrocarbures",
    "codes_nationalites":   "Code de la nationalité",
    "code_travail":         "Code du travail",
}


# ── RAG helpers ───────────────────────────────────────────────────────────────

MONTHS_FR = {
    "janvier": 1, "février": 2, "fevrier": 2, "mars": 3, "avril": 4,
    "mai": 5, "juin": 6, "juillet": 7, "août": 8, "aout": 8,
    "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12, "decembre": 12,
}
_MONTH_RE = re.compile(
    r"\b(" + "|".join(MONTHS_FR) + r")\b(?:\s+(\d{4}))?"
)

_TODAY_WORDS = ["aujourd'hui", "aujourdhui", "du jour", "ce matin", "ce soir", "en ce moment"]
_WEEK_WORDS = [
    "cette semaine", "ces derniers jours", "derniers jours", "récent", "recent",
    "récemment", "recemment", "dernière", "derniers", "actualité", "actualite",
    "quoi de neuf", "nouvelles", "news", "nouveau",
]
_MONTH_WORDS = ["ce mois", "dernières semaines", "dernieres semaines"]
# Questions about upcoming events ("futur déplacement", "prochaine visite"):
# the answer lives in the most recent announcements, so search a recent window.
_FUTURE_WORDS = [
    "futur", "future", "prochain", "prochaine", "à venir", "a venir",
    "bientôt", "bientot", "prévu", "prevu", "prévue", "prevue", "agenda",
]
FUTURE_WINDOW_DAYS = int(os.getenv("FUTURE_WINDOW_DAYS", "14"))


def parse_time_window(question: str) -> tuple[float, float] | None:
    """Extract the time window a question refers to, as (start_ts, end_ts).

    Rule-based on purpose — an LLM call here adds seconds of latency on CPU.
    Returns None for non-temporal questions.
    """
    q = question.lower()
    now = gabon_now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)

    # Explicit month, e.g. "en mars", "mars 2026" → that calendar month
    m = _MONTH_RE.search(q)
    if m:
        month = MONTHS_FR[m.group(1)]
        year = int(m.group(2)) if m.group(2) else (
            now.year if month <= now.month else now.year - 1
        )
        start = datetime(year, month, 1)
        end = datetime(year + (month == 12), month % 12 + 1, 1)
        return gabon_timestamp(start), gabon_timestamp(min(end, now))

    if "hier" in q:
        return gabon_timestamp(today - timedelta(days=1)), gabon_timestamp(now)

    if any(w in q for w in _TODAY_WORDS):
        # Anchor to the newest article so "les nouvelles du jour" still
        # returns yesterday's coverage when today's scrape hasn't run yet.
        anchor = today
        latest = _latest_article_date()
        if latest:
            try:
                anchor = min(datetime.fromisoformat(latest), today)
            except ValueError:
                pass
        return gabon_timestamp(anchor - timedelta(days=1)), gabon_timestamp(now)

    if any(w in q for w in _MONTH_WORDS):
        return gabon_timestamp(today - timedelta(days=30)), gabon_timestamp(now)

    if any(w in q for w in _WEEK_WORDS):
        return gabon_timestamp(today - timedelta(days=7)), gabon_timestamp(now)

    if any(w in q for w in _FUTURE_WORDS):
        return gabon_timestamp(today - timedelta(days=FUTURE_WINDOW_DAYS)), gabon_timestamp(now)

    return None


_FOLLOWUP_PREFIXES = (
    "et ", "mais ", "donc ", "alors ", "encore", "continue",
    "développe", "developpe", "détaille", "detaille", "explique", "précise", "precise",
    "il ", "elle ", "ils ", "elles ",
)
_ANAPHORA_RE = re.compile(
    r"\b(cela|ça|ceci|ce sujet|cette affaire|cette histoire|ce dossier|"
    r"ces articles|la même|le même|les mêmes|d'autres exemples)\b"
)


def is_followup(question: str) -> bool:
    """Heuristic: does this question depend on the previous one for meaning?

    Follow-ups ("et à Port-Gentil ?") embed poorly alone, so retrieval
    combines them with the previous question. Kept conservative — a false
    positive drags an unrelated question into the embedding.
    """
    q = question.lower().strip().rstrip(" ?!.")
    if len(q.split()) <= 4:
        return True
    return q.startswith(_FOLLOWUP_PREFIXES) or bool(_ANAPHORA_RE.search(q))


def temporal_rank(
    items: list[tuple],
    now_ts: float,
    sim_weight: float = SIMILARITY_WEIGHT,
    rec_weight: float = RECENCY_WEIGHT,
    half_life_days: float = RECENCY_HALF_LIFE_DAYS,
) -> list[tuple]:
    """Order (meta, distance, doc) tuples by combined similarity + recency.

    A pure date sort lets a barely-relevant article from today beat a highly
    relevant one from yesterday; exponential time decay trades the two off.
    """
    def score(item):
        meta, dist, _ = item
        similarity = max(0.0, 1.0 - dist / 2.0)
        age_days = max(0.0, (now_ts - float(meta.get("published_ts") or 0)) / 86400.0)
        recency = 0.5 ** (age_days / half_life_days)
        return sim_weight * similarity + rec_weight * recency

    return sorted(items, key=score, reverse=True)


def get_rag_system() -> str:
    today = gabon_today().strftime("%d %B %Y")
    return f"""\
Tu es l'assistant IA du Kiosque, une plateforme d'actualités du Gabon.
Aujourd'hui, nous sommes le {today}.

Règles impératives :
- Tu reçois des extraits d'articles de presse. Réponds au sujet exact de la question \
(la bonne personne, le bon lieu, le bon événement) à partir de leur contenu.
- Même si les articles datent de quelques semaines ou mois, résume ce qu'ils disent.
- N'invente aucune information et n'utilise pas de connaissances externes.
- Si aucun article ne répond directement à la question, dis-le clairement en une phrase, \
puis résume ce que les articles disent de plus proche du sujet. Ne détourne jamais \
la question vers un autre sujet pour donner l'impression de répondre.
- Si les articles couvrent des dates différentes, donne la chronologie des événements.
- Combine les informations de tous les articles.
- Si la question fait suite à un échange précédent, interprète-la dans le contexte \
de la conversation, mais fonde ta réponse sur les articles fournis.

Rédaction :
- Donne une réponse détaillée, structurée et informative en français.
- Utilise des paragraphes et des listes à puces si approprié.
- Mentionne les dates clés des événements.
- Ne mentionne pas les numéros des articles (ils sont affichés séparément).
"""


def get_codes_system() -> str:
    return """\
Tu es l'assistant juridique du Kiosque, une plateforme d'information gabonaise.
Tu réponds à partir d'extraits des codes de loi gabonais (Journal Officiel).

Règles impératives :
- Cite TOUJOURS le numéro exact de l'article de loi que tu utilises (ex: 'Article 12 du Code pénal').
- Reproduis fidèlement le sens des dispositions ; ne reformule jamais de façon approximative.
- N'invente aucune disposition et n'utilise aucune connaissance extérieure aux extraits fournis.
- Si les extraits fournis ne couvrent pas la question, dis-le clairement plutôt que d'extrapoler.
- Termine par : 'Ces informations sont données à titre documentaire et ne constituent pas un conseil juridique.'

Rédaction :
- Réponse claire et structurée en français, accessible à un non-juriste.
- Utilise des listes à puces pour énumérer des conditions ou sanctions.
"""


def build_codes_prompt(question: str, extracts: list["ContextArticle"]) -> str:
    """User-turn prompt for the legal corpus: extracts + question."""
    blocks = []
    for ext in extracts:
        blocks.append(f"[{ext.title}]\n{ext.full_text[:ANSWER_EXCERPT_CHARS]}")
    context = "\n\n---------------------\n\n".join(blocks)

    return (
        f"Question : {question}\n\n"
        "RÈGLES STRICTES :\n"
        "- Réponds uniquement à partir des extraits de codes ci-dessous.\n"
        "- Cite le numéro d'article pour chaque affirmation.\n"
        "- Si les extraits ne couvrent pas la question, dis-le en une phrase.\n\n"
        f"=== EXTRAITS DES CODES ===\n{context}\n=== FIN DES EXTRAITS ===\n\n"
        f"Rappel de la question : {question}\n\n"
        "Réponse :"
    )


def build_rag_prompt(question: str, articles: list["ContextArticle"]) -> str:
    """Build the user-turn prompt containing article context and the question.

    The model persona is already set in the system message (get_rag_system),
    so this prompt focuses solely on context, rules, and the question.
    """
    context_blocks = []
    for i, art in enumerate(articles, 1):
        full_text = art.full_text or art.snippet
        block = (
            f"[Article {i}]\n"
            f"Titre : {art.title}\n"
            f"Date  : {art.date}\n"
            f"Source: {art.source}\n\n"
            f"{full_text[:ANSWER_EXCERPT_CHARS]}"
        )
        context_blocks.append(block)

    context = "\n\n---------------------\n\n".join(context_blocks)

    return (
        f"Question : {question}\n\n"

        "RÈGLES STRICTES :\n"
        "- Réponds uniquement au sujet exact de cette question (la bonne personne, "
        "le bon lieu, le bon événement). Ne réponds jamais sur un autre sujet, même proche.\n"
        "- Utilise uniquement les informations présentes dans les articles.\n"
        "- N'invente aucune information et NE MODIFIE JAMAIS les dates.\n"
        "- L'utilisateur peut demander les'nouvelles du jour', mais les articles fournis peuvent dater d'hier ou des jours précédents. Tu DOIS utiliser les dates exactes fournies dans les métadonnées de chaque article (ex: 'Selon l'article du 23 mars...'). Ne dis jamais que c'est d'aujourd'hui si la date indique le contraire.\n"
        "- N'utilise pas de connaissances extérieures.\n"
        "- Dans le cas normal où les articles contiennent la réponse, réponds directement, "
        "sans précaution oratoire.\n"
        "- Dans le cas contraire (aucun article ne traite le sujet exact demandé), signale-le "
        "en une phrase puis résume ce que les articles disent de plus proche du sujet.\n"
        "- Combine les informations de tous les articles pertinents et privilégie les faits les plus récents.\n"
        "- Si plusieurs articles donnent des chiffres ou des états différents d'un même sujet à des "
        "dates différentes, commence par le plus récent (avec sa date), puis mentionne l'évolution. "
        "Ne présente jamais un chiffre ancien comme s'il était l'état actuel.\n\n"

        "STYLE :\n"
        "- Réponse journalistique claire, factuelle et structurée.\n"
        "- 4 à 8 phrases.\n"
        "- Ne mentionne pas les numéros d'articles.\n\n"

        f"=== ARTICLES ===\n{context}\n=== FIN ARTICLES ===\n\n"
        f"Rappel de la question : {question}\n"
        "Réponds uniquement à cette question, sur son sujet exact.\n\n"
        "Réponse :"
    )


# ── Schemas ───────────────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    question: str = Field(min_length=2, max_length=500)
    n_results: int = Field(default=5, ge=1, le=20)
    # Previous user question, used to disambiguate follow-ups at retrieval time
    previous_question: str = Field(default="", max_length=500)
    corpus: str = Field(default="presse", pattern="^(presse|codes)$")


class ArticleResult(BaseModel):
    title: str
    date: str
    source: str
    category: str
    url: str
    snippet: str
    distance: float
    id: str = ""  # Chroma entry id — used by /answer for the codes corpus


class SearchResponse(BaseModel):
    question: str
    results: list[ArticleResult]


class ContextArticle(BaseModel):
    """One article used as LLM context for /answer (built server-side)."""
    title: str = ""
    date: str = ""
    source: str = ""
    snippet: str = ""
    full_text: str = ""


class ChatTurn(BaseModel):
    """One past question/answer exchange, for conversational context."""
    question: str = ""
    answer: str = ""


class AnswerRequest(BaseModel):
    question: str = Field(min_length=2, max_length=500)
    urls: list[str] = Field(default=[], max_length=20)
    ids: list[str] = Field(default=[], max_length=20)   # codes corpus
    history: list[ChatTurn] = Field(default=[], max_length=6)
    corpus: str = Field(default="presse", pattern="^(presse|codes)$")


_CHUNK_HEADER_END = "]\n\n"  # closes the "[Suite de l'article — partie N]" header


def _fetch_articles(urls: list[str]) -> list[ContextArticle]:
    """Fetch full article texts from ChromaDB for the given source URLs.

    Long articles are stored as several overlapping chunks (chunk 0 keeps the
    raw text; later chunks are prefixed with a synthetic title header at
    indexing time). Chunks are reassembled in order, headers stripped.
    """
    if not urls:
        return []
    res = _collection.get(
        where={"source_url": {"$in": urls}},
        include=["documents", "metadatas"],
    )
    by_url: dict[str, list[tuple[int, str, dict]]] = {}
    for doc, meta in zip(res["documents"], res["metadatas"]):
        by_url.setdefault(meta.get("source_url", ""), []).append(
            (meta.get("chunk", 0), doc, meta)
        )

    articles: list[ContextArticle] = []
    for url in urls:  # preserve the caller's (relevance/date) ordering
        chunks = by_url.get(url)
        if not chunks:
            logger.warning(f"/answer: no document found for {url}")
            continue
        chunks.sort(key=lambda c: c[0])
        parts = []
        for ci, doc, _ in chunks:
            if ci > 0 and doc.startswith("Titre:"):
                end = doc.find(_CHUNK_HEADER_END)
                if end != -1:
                    doc = doc[end + len(_CHUNK_HEADER_END):]
            parts.append(doc)
        meta = chunks[0][2]
        articles.append(ContextArticle(
            title     = meta.get("title", ""),
            date      = meta.get("published_time", "")[:10],
            source    = meta.get("source", ""),
            full_text = "\n\n".join(parts),
        ))
    return articles


# ── Health helpers ────────────────────────────────────────────────────────────

_last_date_cache: dict = {"value": None, "ts": 0.0}
_article_count_cache: dict = {"value": None, "ts": 0.0}
LAST_DATE_TTL = 300  # seconds


def _article_count() -> int:
    """Number of unique articles (total entries minus extra chunks), cached."""
    now = time.time()
    if now - _article_count_cache["ts"] < LAST_DATE_TTL and _article_count_cache["value"] is not None:
        return _article_count_cache["value"]
    total = _collection.count()
    try:
        extra = len(_collection.get(where={"chunk": {"$gt": 0}}, include=[])["ids"])
    except Exception:
        extra = 0
    _article_count_cache["value"] = total - extra
    _article_count_cache["ts"] = now
    return _article_count_cache["value"]


def _latest_article_date() -> str | None:
    """Most recent published_time in the collection (cached, scans metadata)."""
    now = time.time()
    if now - _last_date_cache["ts"] < LAST_DATE_TTL:
        return _last_date_cache["value"]
    try:
        metas = _collection.get(include=["metadatas"])["metadatas"] or []
        latest = max((m.get("published_time", "") for m in metas if m), default="")
        _last_date_cache["value"] = latest[:10] or None
        _last_date_cache["ts"] = now
    except Exception as e:
        logger.warning(f"Could not compute latest article date: {e}")
    return _last_date_cache["value"]


def _ollama_reachable() -> bool:
    try:
        urllib.request.urlopen(f"{OLLAMA_URL}/api/version", timeout=2)
        return True
    except Exception:
        return False


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "articles": _article_count(),
        "llm": CHAT_MODEL,
        "ollama": _ollama_reachable(),
        "last_article_date": _latest_article_date(),
    }


def _code_title(meta: dict) -> str:
    label = CODE_LABELS.get(meta.get("code", ""), meta.get("code", ""))
    numero = meta.get("numero") or meta.get("type", "")
    return f"{label} · {numero}" if numero else label


def _search_codes(question: str, q_vec: list[float], n_results: int) -> "SearchResponse":
    if _codes_collection is None:
        raise HTTPException(
            status_code=503,
            detail="Le corpus des codes juridiques n'est pas disponible.",
        )
    try:
        raw = _codes_collection.query(
            query_embeddings=[q_vec],
            n_results=min(30, _codes_collection.count() or 1),
            include=["documents", "metadatas", "distances"],
        )
    except Exception as e:
        logger.error(f"Codes ChromaDB query error: {e}")
        raise HTTPException(
            status_code=500,
            detail="Erreur lors de la recherche dans les codes juridiques.",
        )

    results: list[ArticleResult] = []
    for id_, meta, dist, doc in zip(
        raw["ids"][0], raw["metadatas"][0], raw["distances"][0], raw["documents"][0]
    ):
        if dist >= CODES_RELEVANCE_THRESHOLD:
            continue
        results.append(ArticleResult(
            title    = _code_title(meta),
            date     = "",
            source   = "Journal Officiel",
            category = CODE_LABELS.get(meta.get("code", ""), meta.get("code", "")),
            url      = meta.get("source_url", ""),
            snippet  = doc[:400] + "..." if len(doc) > 400 else doc,
            distance = round(dist, 4),
            id       = id_,
        ))
        if len(results) >= n_results:
            break
    return SearchResponse(question=question, results=results)


def _fetch_code_extracts(ids: list[str]) -> list[ContextArticle]:
    """Fetch code articles by Chroma id, preserving the caller's order."""
    if not ids or _codes_collection is None:
        return []
    res = _codes_collection.get(ids=ids, include=["documents", "metadatas"])
    by_id = {i: (doc, meta) for i, doc, meta in
             zip(res["ids"], res["documents"], res["metadatas"])}
    extracts = []
    for id_ in ids:
        if id_ not in by_id:
            logger.warning(f"/answer: no code entry found for id {id_}")
            continue
        doc, meta = by_id[id_]
        extracts.append(ContextArticle(
            title     = _code_title(meta),
            source    = "Journal Officiel",
            full_text = doc,
        ))
    return extracts


@app.post("/search", response_model=SearchResponse)
@limiter.limit("30/minute")
def search(request: Request, req: SearchRequest):
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=422, detail="La question est vide.")

    # 1. Extract the time window the question refers to (None = not temporal)
    window = parse_time_window(question)

    # 2. Embed question — follow-ups ("et à Port-Gentil ?") carry too little
    #    meaning alone, so they are embedded together with the previous question
    embed_text = question
    if req.previous_question.strip() and is_followup(question):
        embed_text = f"{req.previous_question.strip()}\n{question}"
    try:
        q_vec = _embedder.embed_query(embed_text)
    except Exception as e:
        logger.error(f"Embedding error: {e}")
        raise HTTPException(
            status_code=503,
            detail="Le service d'embedding (Ollama) est indisponible. Vérifiez qu'Ollama est démarré.",
        )

    # Legal corpus: plain semantic search over code articles, no temporal logic
    if req.corpus == "codes":
        return _search_codes(question, q_vec, req.n_results)

    # 3. Retrieve candidates from ChromaDB.
    #    Temporal queries are filtered to their window server-side via the
    #    numeric published_ts metadata (range operators need numbers).
    n_fetch = TEMPORAL_FETCH_K if window else 30
    query_kwargs = {}
    if window:
        start_ts, end_ts = window
        query_kwargs["where"] = {"$and": [
            {"published_ts": {"$gte": start_ts}},
            {"published_ts": {"$lte": end_ts}},
        ]}
    try:
        raw = _collection.query(
            query_embeddings=[q_vec],
            n_results=min(n_fetch, _collection.count() or 1),
            include=["documents", "metadatas", "distances"],
            **query_kwargs,
        )
    except Exception as e:
        logger.error(f"ChromaDB query error: {e}")
        raise HTTPException(
            status_code=500,
            detail="Erreur lors de la recherche dans la base d'articles.",
        )
    combined = list(zip(raw["metadatas"][0], raw["distances"][0], raw["documents"][0]))

    # 3b. Long articles are indexed as several chunks — keep only the
    #     best-matching chunk per article (results come back distance-sorted).
    seen_urls: set[str] = set()
    deduped = []
    for m, d, doc in combined:
        key = m.get("source_url", "")
        if key in seen_urls:
            continue
        seen_urls.add(key)
        deduped.append((m, d, doc))
    combined = deduped

    # 4. Filter / rank
    if window:
        # Relaxed relevance cutoff (generic queries like "news of the day"
        # match everything weakly), then time-decay ranking.
        combined = [
            (m, d, doc) for m, d, doc in combined if d < 3.0
        ]
        combined = temporal_rank(combined, now_ts=time.time())
    else:
        combined = [
            (m, d, doc) for m, d, doc in combined if d < RELEVANCE_THRESHOLD
        ]
        combined = temporal_rank(
            combined, now_ts=time.time(),
            sim_weight=NONTEMPORAL_SIM_WEIGHT,
            rec_weight=NONTEMPORAL_REC_WEIGHT,
            half_life_days=NONTEMPORAL_HALF_LIFE_DAYS,
        )
    combined = combined[:req.n_results]

    articles: list[ArticleResult] = []
    for meta, dist, doc in combined:
        snippet = doc[:400] + "..." if len(doc) > 400 else doc
        articles.append(ArticleResult(
            title    = meta.get("title", ""),
            date     = meta.get("published_time", "")[:10],
            source   = meta.get("source", ""),
            category = meta.get("category", ""),
            url      = meta.get("source_url", ""),
            snippet  = snippet,
            distance = round(dist, 4),
        ))

    return SearchResponse(question=question, results=articles)


@app.post("/answer")
@limiter.limit("6/minute")
def answer(request: Request, req: AnswerRequest):
    try:
        if req.corpus == "codes":
            context_items = _fetch_code_extracts(req.ids)
        else:
            context_items = _fetch_articles(req.urls)
    except Exception as e:
        logger.error(f"/answer context fetch error: {e}")
        raise HTTPException(
            status_code=500,
            detail="Erreur lors de la récupération des articles.",
        )
    if not context_items:
        empty_msg = (
            "Aucun article de code pertinent n'a été trouvé pour cette question."
            if req.corpus == "codes"
            else "Aucun article pertinent n'a été trouvé pour cette recherche."
        )
        return StreamingResponse(iter([empty_msg]), media_type="text/plain")

    if req.corpus == "codes":
        system_prompt = get_codes_system()
        user_prompt = build_codes_prompt(req.question.strip(), context_items)
    else:
        system_prompt = get_rag_system()
        user_prompt = build_rag_prompt(req.question.strip(), context_items)

    messages = [SystemMessage(content=system_prompt)]
    # Replay recent exchanges so follow-up questions are understood in context
    for turn in req.history[-3:]:
        if turn.question.strip() and turn.answer.strip():
            messages.append(HumanMessage(content=turn.question[:500]))
            messages.append(AIMessage(content=turn.answer[:1200]))
    messages.append(HumanMessage(content=user_prompt))

    def generate():
        try:
            for chunk in _llm.stream(messages):
                yield chunk.content
        except Exception as e:
            logger.error(f"LLM streaming error: {e}")
            yield (
                "\n\n[Erreur : la génération a été interrompue. "
                "Vérifiez qu'Ollama est démarré puis réessayez.]"
            )

    return StreamingResponse(generate(), media_type="text/plain")


_report_cache: dict = {
    "weekly": {"key": None, "text": None},
    "daily": {"key": None, "text": None},
}

# Dedicated LLM handle for the weekly report: hard output cap so generation stays
# bounded. Same num_ctx as the chat handle — a different value would force Ollama
# to reload the model between chat and report calls (minutes lost each switch).
REPORT_NUM_CTX = int(os.getenv("REPORT_NUM_CTX", str(CHAT_NUM_CTX)))
_report_llm = ChatOllama(
    model=CHAT_MODEL,
    temperature=0.3,
    num_ctx=REPORT_NUM_CTX,
    num_predict=2000,
    **({"reasoning": REASONING_ENABLED}
       if CHAT_MODEL.lower().startswith(_REASONING_MODEL_PREFIXES) else {}),
)


def get_weekly_system() -> str:
    today = gabon_today().strftime("%d %B %Y")
    return f"""\
Tu es le rédacteur en chef du Kiosque, une plateforme d'actualités gabonaise.
Nous sommes le {today}. Tu rédiges la revue de presse hebdomadaire à partir
des titres publiés cette semaine par la presse gabonaise.

Règles :
- Commence DIRECTEMENT par un court paragraphe d'ouverture donnant le ton de la \
semaine avec les chiffres clés fournis. Pas de préambule, pas de titre général, \
pas de formule du type 'Voici la revue'.
- Puis 4 à 6 grands thèmes. Intertitre de thème : une courte ligne en gras \
(**Thème**). N'utilise JAMAIS la syntaxe '#' ni de lignes '---'.
- Sous chaque thème, une phrase de mise en contexte puis 3 à 5 puces \
synthétisant les faits marquants, avec les dates.
- Termine par un court paragraphe de conclusion sur ce que la semaine annonce.
- Appuie-toi uniquement sur les titres fournis ; n'invente aucun détail.
- Français journalistique dense. Vise 500 à 650 mots au total : couvre les \
faits les plus importants de la semaine sans délayer.
"""


def _collect_week(days: int = 7, start: "datetime | None" = None):
    """Rows since `start` (default: N days back at midnight):
    (date, source, category, title, url), one per article."""
    now = gabon_now()
    if start is None:
        start = (now - timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)
    res = _collection.get(
        where={"published_ts": {"$gte": gabon_timestamp(start)}},
        include=["metadatas"],
    )
    rows = sorted(
        {
            m["source_url"]: (
                str(m.get("published_time", ""))[:10],
                m.get("source", ""),
                m.get("category", ""),
                m.get("title", ""),
                m.get("source_url", ""),
            )
            for m in res["metadatas"]
            if m and not m.get("chunk", 0)
        }.values()
    )
    return start, now, rows


def get_daily_system(start: "date | None" = None) -> str:
    today = gabon_today().strftime("%d %B %Y")
    if start == gabon_today():
        covered = "Les titres fournis ont été publiés aujourd'hui."
    elif start:
        covered = (f"Les titres fournis datent du {start.strftime('%d %B %Y')} "
                   "(dernier jour couvert par la collecte).")
    else:
        covered = "Les titres fournis sont les plus récents du corpus."
    return f"""\
Tu es le rédacteur en chef du Kiosque, une plateforme d'actualités gabonaise.
Nous sommes le {today}. Tu rédiges le point d'actualité du jour à partir des
titres les plus récents publiés par la presse gabonaise. {covered}

Règles :
- Date les faits dès l'ouverture quand ils ne sont pas d'aujourd'hui \
(ex. « L'actualité du 16 juillet… ») ; ne présente jamais comme étant \
d'aujourd'hui des faits d'un autre jour.
- Commence DIRECTEMENT par une ou deux phrases d'ouverture donnant le ton du \
jour avec les chiffres clés fournis. Pas de préambule, pas de titre général, \
pas de formule du type 'Voici le point'.
- Puis 3 à 4 grands thèmes. Intertitre de thème : une courte ligne en gras \
(**Thème**). N'utilise JAMAIS la syntaxe '#' ni de lignes '---'.
- Sous chaque thème, 2 à 4 puces synthétisant les faits marquants.
- Termine par une phrase de conclusion sur ce qui est à suivre.
- Appuie-toi uniquement sur les titres fournis ; n'invente aucun détail.
- Français journalistique dense. Vise 250 à 400 mots au total.
"""


def _weekly_messages(start, now, rows, *, daily: bool = False):
    from collections import Counter
    by_source = Counter(r[1] for r in rows)
    by_category = Counter(r[2] for r in rows if r[2])
    by_day = Counter(r[0] for r in rows)
    period = "DU JOUR" if daily else "DE LA SEMAINE"
    stats_block = (
        f"CHIFFRES CLÉS {period} ({start.date()} → {now.date()}) :\n"
        f"- {len(rows)} articles publiés par {len(by_source)} sources\n"
        f"- Jour le plus actif : {max(by_day, key=by_day.get)} ({max(by_day.values())} articles)\n"
        f"- Rubriques dominantes : "
        + ", ".join(f"{c} ({n})" for c, n in by_category.most_common(5))
    )
    # Cap the prompt size: keep the most recent titles if the period is very dense
    MAX_TITLES = 300
    titles_block = "\n".join(f"{d} | {s} | {t}" for d, s, c, t, _u in rows[-MAX_TITLES:])
    messages = [
        SystemMessage(content=get_daily_system(start.date()) if daily else get_weekly_system()),
        HumanMessage(content=(
            f"{stats_block}\n\n"
            f"=== TITRES {period} ===\n{titles_block}\n=== FIN DES TITRES ===\n\n"
            + ("Rédige le point d'actualité du jour :" if daily
               else "Rédige la revue de presse hebdomadaire :")
        )),
    ]
    return messages, by_source, by_category, by_day


def _maybe_cache_report(cache_key, text: str, kind: str = "weekly") -> None:
    # Only cache output that ends like a finished sentence — a stream cut
    # by the context limit would otherwise be served forever
    if text and text[-1] in ".!?»)":
        _report_cache[kind]["key"] = cache_key
        _report_cache[kind]["text"] = text
    else:
        logger.warning(f"/{kind}_report: output looks truncated, not cached")


def _collect_report(daily: bool):
    """Article window for the daily/weekly reports (stream and PDF).

    Daily: strictly today's articles; if today is still empty (morning before
    the first scrape, publication gap), slide onto the most recent covered
    day, like /search's "today" anchor. Weekly: the last 7 days.
    """
    if not daily:
        return _collect_week(days=7)
    today0 = gabon_now().replace(hour=0, minute=0, second=0, microsecond=0)
    start, now, rows = _collect_week(start=today0)
    if not rows:
        latest = _latest_article_date()
        if latest:
            try:
                anchor = datetime.fromisoformat(latest).replace(
                    hour=0, minute=0, second=0, microsecond=0)
                start, now, rows = _collect_week(start=anchor)
            except ValueError:
                pass
    return start, now, rows


def _stream_report(kind: str):
    """Shared implementation of /weekly_report and /daily_report."""
    daily = kind == "daily"
    empty_msg = ("Aucun article publié aujourd'hui dans le corpus." if daily
                 else "Aucun article publié cette semaine dans le corpus.")
    try:
        start, now, rows = _collect_report(daily)
    except Exception as e:
        logger.error(f"/{kind}_report fetch error: {e}")
        raise HTTPException(status_code=500, detail="Erreur lors de la lecture des articles.")
    if not rows:
        return StreamingResponse(iter([empty_msg]), media_type="text/plain")

    cache_key = (start.date().isoformat(), len(rows))
    if _report_cache[kind]["key"] == cache_key:
        return StreamingResponse(iter([_report_cache[kind]["text"]]), media_type="text/plain")

    messages, *_ = _weekly_messages(start, now, rows, daily=daily)

    def generate():
        chunks = []
        try:
            for chunk in _report_llm.stream(messages):
                chunks.append(chunk.content)
                yield chunk.content
            _maybe_cache_report(cache_key, "".join(chunks).strip(), kind=kind)
        except Exception as e:
            logger.error(f"/{kind}_report LLM error: {e}")
            yield "\n\n[Erreur : la génération a été interrompue. Réessayez.]"

    return StreamingResponse(generate(), media_type="text/plain")


@app.get("/weekly_report")
@limiter.limit("4/minute")
def weekly_report(request: Request):
    """Stream an LLM-written press review of the last 7 days (titles-based)."""
    return _stream_report("weekly")


@app.get("/daily_report")
@limiter.limit("4/minute")
def daily_report(request: Request):
    """Stream an LLM-written news brief of the last day (titles-based)."""
    return _stream_report("daily")


def _report_pdf(kind: str):
    """Shared implementation of /weekly_report/pdf and /daily_report/pdf."""
    daily = kind == "daily"
    try:
        start, now, rows = _collect_report(daily)
    except Exception as e:
        logger.error(f"/{kind}_report/pdf fetch error: {e}")
        raise HTTPException(status_code=500, detail="Erreur lors de la lecture des articles.")
    if not rows:
        raise HTTPException(status_code=404,
                            detail="Aucun article publié aujourd'hui." if daily
                            else "Aucun article publié cette semaine.")

    cache_key = (start.date().isoformat(), len(rows))
    messages, by_source, by_category, by_day = _weekly_messages(start, now, rows, daily=daily)

    if _report_cache[kind]["key"] == cache_key:
        text = _report_cache[kind]["text"]
    else:
        try:
            text = _report_llm.invoke(messages).content.strip()
        except Exception as e:
            logger.error(f"/{kind}_report/pdf LLM error: {e}")
            raise HTTPException(status_code=503, detail="La génération du rapport a échoué.")
        _maybe_cache_report(cache_key, text, kind=kind)

    try:
        from report_pdf import build_weekly_pdf
        pdf = build_weekly_pdf(text, start, now, len(rows), by_source, by_category, by_day,
                               articles=rows, daily=daily)
    except Exception as e:
        logger.error(f"/{kind}_report/pdf build error: {e}")
        raise HTTPException(status_code=500, detail="Erreur lors de la construction du PDF.")

    from fastapi.responses import Response
    filename = (f"lekiosque-point-du-jour-{now.date()}.pdf" if daily
                else f"lekiosque-revue-semaine-{now.date()}.pdf")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/weekly_report/pdf")
@limiter.limit("4/minute")
def weekly_report_pdf(request: Request):
    """Downloadable PDF: weekly summary text + charts."""
    return _report_pdf("weekly")


@app.get("/daily_report/pdf")
@limiter.limit("4/minute")
def daily_report_pdf(request: Request):
    """Downloadable PDF: daily summary text + charts."""
    return _report_pdf("daily")


if __name__ == "__main__":
    uvicorn.run("api:app", host="0.0.0.0", port=int(os.getenv("API_PORT", "8000")), reload=False)
