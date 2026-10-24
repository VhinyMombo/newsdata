#!/usr/bin/env python3
"""
Lightweight FastAPI server providing a RAG search + answer endpoint.

Embeds the user's question, retrieves the top-K articles from ChromaDB,
then generates a synthesised answer with the configured chat model
(local Ollama, or a hosted API — see llm.py).

Usage:
    .venv/bin/python api.py          # runs on http://localhost:8000
"""

import json
import logging
import math
import os
import re
import time
import unicodedata
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import chromadb
import uvicorn
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi import Path as PathParam
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_ollama.embeddings import OllamaEmbeddings
from pydantic import BaseModel, Field

import auth
import llm
import mailer
import oauth

load_dotenv()

ROOT_DIR = Path(__file__).parent
PERSIST_DIR = ROOT_DIR / "newspaper_chroma_db"
COLLECTION_NAME = "newspaper_gabon"
CODES_PERSIST_DIR = ROOT_DIR / "codes_chroma_db"
CODES_COLLECTION_NAME = "codes_gabon"
EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma")
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
# In a time window, candidates within this cosine distance of the best match rank first
WINDOW_RELEVANCE_MARGIN = float(os.getenv("WINDOW_RELEVANCE_MARGIN", "0.2"))
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
# Same for law articles, whose finance-law tables run far longer than a press
# article; past this, the lines that match the question are kept (see _law_excerpt)
CODES_EXCERPT_CHARS = int(os.getenv("CODES_EXCERPT_CHARS", "8000"))
# Ollama context window for the chat model (must fit system + 5 articles + question)
CHAT_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "16384"))
# Web push (see push_notify.py) — keys generated once via py-vapid, stored in .env
VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY", "")

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
    # Custom response headers aren't exposed to browser JS by default even
    # with allow_headers="*" (that governs the request side); the frontend
    # reads X-Report-Source to tell a cache hit from a fresh generation
    expose_headers=["X-Report-Source", "X-Answer-Source"],
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
CHAT_MODEL = llm.MODEL
_llm = llm.chat_model(temperature=0.2, num_ctx=CHAT_NUM_CTX)
logger.info(f"✅ {_collection.count()} articles ready  |  LLM: {llm.PROVIDER}/{CHAT_MODEL}")

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
    "loi_de_finances_2026": "Loi de Finances 2026",
    "projet_loi_de_finances_2027": "Projet de loi de finances 2027 (non adopté)",
}

# Browse index for the Codes de loi side panel: entries grouped by code,
# ordered by their original row in the source CSV (which already follows
# the code's own Titre/Chapitre/Article structure). Built once at startup —
# the whole corpus is ~1,500 short metadata rows, trivial to hold in memory,
# and this avoids re-scanning Chroma on every browse request.
_CODES_INDEX: dict[str, list[dict]] = {}
if _codes_collection is not None:
    try:
        _all = _codes_collection.get(include=["metadatas"])
        _by_code: dict[str, list[tuple[int, dict]]] = {}
        for id_, meta in zip(_all["ids"], _all["metadatas"]):
            code = meta.get("code", "")
            _by_code.setdefault(code, []).append((meta.get("row") or 0, {
                "id": id_,
                "numero": meta.get("numero", ""),
                "type": meta.get("type", ""),
                "contexte": meta.get("contexte", ""),
            }))
        _CODES_INDEX = {
            code: [item for _, item in sorted(entries, key=lambda t: t[0])]
            for code, entries in _by_code.items()
        }
    except Exception as e:
        logger.warning(f"Codes browse index build failed: {e}")


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
# "Que retenir de la journée ?" means today, but "la journée nationale du
# retraité" is an event: only a bare "de la journée" / "cette journée" counts
_TODAY_RE = re.compile(
    r"\b(?:de la|cette) journée\b(?!\s+(?:nationale|mondiale|internationale|africaine|de |du |des |d'|d’))"
)
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

    if any(w in q for w in _TODAY_WORDS) or _TODAY_RE.search(q):
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


def _date_fr(d: date) -> str:
    months = list(MONTHS_FR)  # insertion order: janvier … décembre, with accentless twins
    names = [m for m in months if m not in ("fevrier", "aout", "decembre")]
    return f"{d.day} {names[d.month - 1]} {d.year}"


def get_rag_system() -> str:
    today = gabon_today()
    latest = _latest_article_date()
    # Before the first collection of the day, the newest articles are from the
    # day before: the model must date them, not call them "today"
    latest_line = ""
    if latest:
        try:
            latest_d = date.fromisoformat(latest)
            if latest_d < today:
                latest_line = (f"Les articles les plus récents du corpus datent du {_date_fr(latest_d)} : "
                               "la collecte du jour n'a pas encore eu lieu.\n")
        except ValueError:
            pass
    return f"""\
Tu es l'assistant IA du Kiosque, une plateforme d'actualités du Gabon.
Aujourd'hui, nous sommes le {_date_fr(today)}.
{latest_line}
Règles impératives :
- Tu reçois des extraits d'articles de presse. Réponds au sujet exact de la question \
(la bonne personne, le bon lieu, le bon événement) à partir de leur contenu.
- Même si les articles datent de quelques semaines ou mois, résume ce qu'ils disent.
- N'invente aucune information et n'utilise pas de connaissances externes.
- Si aucun article ne répond directement à la question, dis-le clairement en une phrase, \
puis résume ce que les articles disent de plus proche du sujet. Ne détourne jamais \
la question vers un autre sujet pour donner l'impression de répondre.
- Si les articles couvrent des dates différentes, donne la chronologie des événements.
- Si la question porte sur aujourd'hui ou la journée et que les articles datent d'un jour \
précédent, ne les présente jamais comme ceux d'aujourd'hui : annonce leur date réelle, par \
exemple « Le 22 octobre, dernière journée couverte, … ».
- Combine les informations de tous les articles.
- Si la question fait suite à un échange précédent, interprète-la dans le contexte \
de la conversation, mais fonde ta réponse sur les articles fournis.

Rédaction :
- Donne une réponse détaillée, structurée et informative en français.
- Utilise des paragraphes et des listes à puces si approprié.
- N'utilise jamais l'italique (pas d'astérisque simple autour d'un mot) ; le gras est permis.
- Mentionne les dates clés des événements.
- Cite tes sources dans le texte : après chaque information, indique entre crochets le \
numéro de l'article d'où elle vient, par exemple [1], ou [2][3] si plusieurs articles la \
donnent. N'utilise que les numéros des articles fournis. Le lecteur touche ces numéros \
pour ouvrir l'article.
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
- Tu peux comparer et calculer à partir des chiffres des extraits, même s'ils viennent de textes différents (loi de finances 2026 et projet de loi de finances 2027) : donne chaque chiffre avec son article, puis l'écart. Précise que le projet 2027 n'est pas encore adopté.
- Si les extraits ne couvrent qu'une partie de la question, réponds sur cette partie et dis ce qui manque.
- Termine par : 'Ces informations sont données à titre documentaire et ne constituent pas un conseil juridique.'

Rédaction :
- Réponse claire et structurée en français, accessible à un non-juriste.
- Utilise des listes à puces pour énumérer des conditions ou sanctions.
- N'utilise jamais l'italique (pas d'astérisque simple autour d'un mot) ; le gras est permis.
"""


_EXCERPT_STOPWORDS = {
    "dans", "pour", "avec", "elle", "elles", "sont", "quel", "quelle", "quels", "quelles",
    "comment", "combien", "est-ce", "cette", "entre", "leur", "leurs", "plus", "moins",
    "loi", "lois", "finances", "article", "articles", "projet", "2026", "2027",
}


def _fold(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def _law_excerpt(text: str, question: str, limit: int) -> str:
    """The article as the model should read it. A long one (a finance law's
    staff or mission tables) is cut down to its opening, then the lines that
    share a word with the question, each with the title and header row of its
    table, in the article's order; "[…]" marks what was left out. A plain cut
    would drop the row asked about whenever it sits past the limit."""
    if len(text) <= limit:
        return text
    stems = {_fold(w)[:6] for w in re.findall(r"[\w-]{4,}", question) if _fold(w) not in _EXCERPT_STOPWORDS}
    lines = text.split("\n")
    folded = [_fold(l) for l in lines]
    keep: set[int] = set()
    size = 0
    for i, line in enumerate(lines):  # the opening, which says what the article is about
        if size + len(line) > limit // 4:
            break
        keep.add(i)
        size += len(line) + 1

    def table_head(i: int) -> list[int]:
        """Header row and title of the Markdown table that line i belongs to."""
        if not lines[i].startswith("|"):
            return []
        j = i
        while j > 0 and lines[j - 1].startswith("|"):
            j -= 1
        head = [j, j + 1]  # header row and its | --- | separator
        k = j - 1
        while k >= 0 and not lines[k].strip():
            k -= 1
        return head + ([k] if k >= 0 else [])

    scored = sorted(
        ((sum(s in f for s in stems), i) for i, f in enumerate(folded)),
        key=lambda t: (-t[0], t[1]),
    )
    for score, i in scored:
        if score == 0:
            break
        new = [n for n in [i, *table_head(i)] if n not in keep]
        cost = sum(len(lines[n]) + 1 for n in new)
        if size + cost > limit:
            continue
        keep.update(new)
        size += cost
    out, last = [], -1
    for i in sorted(keep):
        if i > last + 1:
            out.append("[…]")
        out.append(lines[i])
        last = i
    if last < len(lines) - 1:
        out.append("[…]")
    return "\n".join(out)


def build_codes_prompt(question: str, extracts: list["ContextArticle"]) -> str:
    """User-turn prompt for the legal corpus: extracts + question."""
    blocks = []
    for ext in extracts:
        blocks.append(f"[{ext.title}]\n{_law_excerpt(ext.full_text, question, CODES_EXCERPT_CHARS)}")
    context = "\n\n---------------------\n\n".join(blocks)

    return (
        f"Question : {question}\n\n"
        "RÈGLES STRICTES :\n"
        "- Réponds uniquement à partir des extraits de codes ci-dessous.\n"
        "- Cite le numéro d'article pour chaque affirmation.\n"
        "- Comparer ou calculer à partir des chiffres des extraits est permis.\n"
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
        # Numbered as in the reader's source list, even if an article went missing
        block = (
            f"[Article {art.ref or i}]\n"
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
        "- Après chaque information, cite entre crochets le numéro de l'article d'où elle vient, "
        "par exemple [1] ou [2][3]. Uniquement les numéros des articles fournis, "
        "sans écrire « Article » ni le titre.\n\n"

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
    # Comparison mode ("vs" period picker): explicit ISO dates override the
    # question-text temporal parsing below. Both or neither — a lone date
    # is ambiguous (open-ended window? single day?) so it's rejected.
    period_start: str | None = Field(default=None)
    period_end: str | None = Field(default=None)


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
    # Position in the reader's source list, which the answer cites as [n]
    ref: int = 0


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
    for ref, url in enumerate(urls, 1):  # preserve the caller's (relevance/date) ordering
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
            ref       = ref,
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


# ── Auth ──────────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=8, max_length=200)
    display_name: str = Field(min_length=1, max_length=80)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=200)


class ForgotPasswordRequest(BaseModel):
    email: str = Field(min_length=3, max_length=200)


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    password: str = Field(min_length=8, max_length=200)


class LoginCodeRequest(BaseModel):
    code: str = Field(min_length=20, max_length=100)


class UpdateProfileRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=80)
    current_password: str | None = Field(default=None, max_length=200)
    new_password: str | None = Field(default=None, min_length=8, max_length=200)


class FollowRequest(BaseModel):
    type: str = Field(pattern="^(keyword|source|theme)$")
    value: str = Field(min_length=1, max_length=200)
    label: str = Field(min_length=1, max_length=200)


class ConversationTurn(BaseModel):
    question: str = Field(min_length=1, max_length=500)
    answer: str = Field(default="", max_length=20000)
    # The cited articles, as the frontend shows them (title, url, source, date…)
    sources: list[dict] = Field(default=[], max_length=10)


class SaveConversationRequest(BaseModel):
    corpus: str = Field(default="presse", pattern="^(presse|codes)$")
    turns: list[ConversationTurn] = Field(min_length=1, max_length=40)


_CONV_ID = PathParam(pattern=r"^[A-Za-z0-9_-]{1,40}$")
CONVERSATION_MAX_BYTES = 400_000


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=1, max_length=500)
    auth: str = Field(min_length=1, max_length=500)


class PushSubscribeRequest(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2000)
    keys: PushKeys


def _bearer_token(authorization: str | None = Header(default=None)) -> str | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return authorization.removeprefix("Bearer ").strip()


def require_user(token: str | None = Depends(_bearer_token)) -> dict:
    user = auth.get_user_by_token(token) if token else None
    if not user:
        raise HTTPException(status_code=401, detail="Authentification requise.")
    return user


@app.post("/auth/register")
@limiter.limit("5/minute")
def register(request: Request, req: RegisterRequest):
    try:
        user, token = auth.create_user(req.email, req.password, req.display_name)
    except auth.AuthError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"user": user, "token": token}


@app.post("/auth/login")
@limiter.limit("10/minute")
def login(request: Request, req: LoginRequest):
    try:
        user, token = auth.authenticate(req.email, req.password)
    except auth.AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    return {"user": user, "token": token}


PUBLIC_URL = os.getenv("PUBLIC_URL", "https://lekiosque.hodologic.fr").rstrip("/")


def _send_reset_mail(user: dict, token: str) -> None:
    link = f"{PUBLIC_URL}/#/reinitialiser?token={token}"
    name = user["display_name"].split(" ")[0]
    text = (
        f"Bonjour {name},\n\n"
        "Pour choisir un nouveau mot de passe sur Le Kiosque, ouvrez ce lien :\n"
        f"{link}\n\n"
        "Il est valable une heure et ne sert qu'une fois. Si vous n'avez rien demandé, "
        "ignorez ce message : votre mot de passe actuel reste valable.\n\n"
        "Le Kiosque\nhttps://lekiosque.hodologic.fr"
    )
    html = f"""<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;color:#0F2A3A">
<div style="border-top:4px solid #7A1F2B;padding-top:20px;text-align:center">
<img src="{PUBLIC_URL}/icons/icon-192.png" width="56" height="56" alt="" style="border-radius:12px">
<div style="font-size:24px;font-weight:600;margin-top:10px">Le Kiosque</div></div>
<p style="font-size:16px;line-height:1.5;margin-top:24px">Bonjour {name},</p>
<p style="font-size:16px;line-height:1.5">Pour choisir un nouveau mot de passe, touchez le bouton ci-dessous.</p>
<p style="text-align:center;margin:28px 0"><a href="{link}" style="background:#7A1F2B;color:#fff;text-decoration:none;padding:14px 24px;border-radius:10px;font-family:Arial,sans-serif;font-weight:600;font-size:15px">Choisir un nouveau mot de passe</a></p>
<p style="font-size:14px;line-height:1.5;color:#5B6B7A">Le lien est valable une heure et ne sert qu'une fois. Si vous n'avez rien demandé, ignorez ce message : votre mot de passe actuel reste valable.</p>
</div>"""
    mailer.send(user["email"], "Le Kiosque : votre nouveau mot de passe", text, html)


@app.post("/auth/forgot")
@limiter.limit("3/minute")
def forgot_password(request: Request, req: ForgotPasswordRequest):
    # Same answer whether or not the address has an account: the form must not
    # reveal who is registered
    if not mailer.configured():
        raise HTTPException(status_code=503, detail="L'envoi d'e-mails n'est pas disponible pour le moment.")
    found = auth.create_password_reset(req.email)
    if found:
        try:
            _send_reset_mail(*found)
        except Exception:
            logger.exception("password reset mail failed")
            raise HTTPException(status_code=502, detail="L'e-mail n'a pas pu partir. Réessayez dans un instant.")
    return {"status": "ok"}


@app.post("/auth/reset")
@limiter.limit("10/minute")
def reset_password(request: Request, req: ResetPasswordRequest):
    try:
        user, token = auth.reset_password(req.token, req.password)
    except auth.AuthError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"user": user, "token": token}


# ── Sign-in with Google or Facebook ─────────────────────────────────────────
# start → the provider's page → callback → back to the app with a one-time code
# (#/connexion?code=…) that the app trades for a session at /auth/exchange.

_PROVIDER = PathParam(pattern="^(google|facebook)$")


def _oauth_redirect_uri(provider: str) -> str:
    return f"{PUBLIC_URL}/api/auth/{provider}/callback"


def _back_to_app(**params: str) -> RedirectResponse:
    return RedirectResponse(f"{PUBLIC_URL}/#/connexion?{urllib.parse.urlencode(params)}", status_code=303)


@app.get("/auth/providers")
def auth_providers(test: str = ""):
    # Facebook stays hidden until Meta has reviewed the app (FACEBOOK_LIVE=1): until
    # then only its testers, who open #/tester-facebook once, see the button
    shown = oauth.configured()
    if os.getenv("FACEBOOK_LIVE") != "1" and test != "facebook":
        shown = [p for p in shown if p != "facebook"]
    return {"providers": shown}


def _sheet_page(title: str, text: str) -> HTMLResponse:
    """The end of a sign-in started from the installed app. In a browser sheet over
    the app, the app underneath has the result and the reader closes the sheet. When
    iPhone brings the page back inside the app itself, the page finds the app's
    secret in storage, collects the session and returns to the front page."""
    return HTMLResponse(f"""<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{title} · Le Kiosque</title></head>
<body style="margin:0;font:17px/1.55 Georgia,serif;color:#0F2A3A;background:#fff">
<main style="max-width:420px;margin:0 auto;padding:56px 24px;text-align:center">
<img src="/icons/icon-192.png" width="64" height="64" alt="" style="border-radius:14px">
<h1 style="font-weight:400;font-size:1.6rem;margin:20px 0 10px">{title}</h1>
<p style="color:#34495A">{text}</p>
<p id="close" style="margin-top:28px;font:600 15px/1.4 system-ui,sans-serif;color:#7A1F2B">Touchez ✕ en haut à gauche pour revenir au Kiosque.</p>
<p><a href="/" style="display:inline-block;margin-top:8px;padding:12px 20px;border-radius:10px;background:#7A1F2B;color:#fff;text-decoration:none;font:600 15px/1 system-ui,sans-serif">Revenir au Kiosque</a></p>
</main>
<script>
(function () {{
  var secret; try {{ secret = localStorage.getItem('lekiosque_app_wait'); }} catch (e) {{}}
  if (!secret) return;
  document.getElementById('close').textContent = 'Retour au Kiosque…';
  fetch('/api/auth/app-wait?app=' + encodeURIComponent(secret)).then(function (r) {{ return r.json(); }}).then(function (b) {{
    if (b.status === 'ok') localStorage.setItem('lekiosque_auth_token', b.token);
  }}).catch(function () {{}}).then(function () {{
    try {{ localStorage.removeItem('lekiosque_app_wait'); }} catch (e) {{}}
    location.replace('/');
  }});
}})();
</script></body></html>""")


@app.get("/auth/{provider}/start")
@limiter.limit("20/minute")
def oauth_start(request: Request, provider: str = _PROVIDER, app_wait: str = Query(default="", alias="app", max_length=100)):
    if provider not in oauth.configured():
        raise HTTPException(status_code=404, detail="Connexion indisponible.")
    state = auth.create_oauth_state(provider, app_wait if len(app_wait) >= 20 else None)
    return RedirectResponse(oauth.authorize_url(provider, _oauth_redirect_uri(provider), state), status_code=303)


@app.get("/auth/{provider}/callback")
@limiter.limit("20/minute")
def oauth_callback(request: Request, provider: str = _PROVIDER, code: str = "", state: str = "", error: str = ""):
    valid, app_hash = auth.consume_oauth_state(state, provider) if provider in oauth.configured() else (False, None)
    if not valid:
        return _back_to_app(erreur="expire")

    def fail(kind: str, message: str):
        if app_hash:
            auth.finish_app_login(app_hash, error=message)
            return _sheet_page("Connexion impossible", message)
        return _back_to_app(erreur=kind, message=message)

    if error or not code:
        # The reader closed the provider's page or refused
        return fail("annule", "La connexion a été annulée.")
    try:
        ident = oauth.identity(provider, code, _oauth_redirect_uri(provider))
        user_id = auth.login_with_identity(provider, ident)
    except auth.AuthError as e:
        return fail("compte", str(e))
    except oauth.OAuthError:
        logger.exception("%s sign-in failed", provider)
        return fail("fournisseur", "Le service de connexion n'a pas répondu. Réessayez dans un instant.")
    if app_hash:
        auth.finish_app_login(app_hash, user_id=user_id)
        return _sheet_page("Vous êtes connecté", "Le Kiosque vous a reconnu.")
    return _back_to_app(code=auth.create_login_code(user_id))


@app.get("/auth/app-wait")
@limiter.limit("60/minute")
def oauth_app_wait(request: Request, app_wait: str = Query(alias="app", min_length=20, max_length=100)):
    return auth.app_login_result(app_wait)


@app.post("/auth/exchange")
@limiter.limit("20/minute")
def exchange_login_code(request: Request, req: LoginCodeRequest):
    try:
        user, token = auth.exchange_login_code(req.code)
    except auth.AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    return {"user": user, "token": token}


@app.post("/auth/logout")
def logout(token: str | None = Depends(_bearer_token)):
    if token:
        auth.delete_session(token)
    return {"status": "ok"}


@app.get("/auth/me")
def me(user: dict = Depends(require_user)):
    return user


@app.delete("/auth/me")
def delete_me(user: dict = Depends(require_user)):
    auth.delete_user(user["id"])
    return {"status": "ok"}


@app.patch("/auth/me")
def update_me(req: UpdateProfileRequest, user: dict = Depends(require_user)):
    try:
        updated = auth.update_profile(
            user["id"],
            display_name=req.display_name,
            current_password=req.current_password,
            new_password=req.new_password,
        )
    except auth.AuthError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return updated


@app.get("/follows")
def get_follows(user: dict = Depends(require_user)):
    return auth.list_follows(user["id"])


@app.post("/follows")
def post_follow(req: FollowRequest, user: dict = Depends(require_user)):
    auth.add_follow(user["id"], req.type, req.value, req.label)
    return auth.list_follows(user["id"])


@app.delete("/follows")
def delete_follow(type: str, value: str, user: dict = Depends(require_user)):
    auth.remove_follow(user["id"], type, value)
    return auth.list_follows(user["id"])


# Assistant conversations kept for signed-in readers, to reopen from any device
@app.get("/conversations")
def get_conversations(user: dict = Depends(require_user)):
    return auth.list_conversations(user["id"])


@app.get("/conversations/{conv_id}")
def get_conversation(conv_id: str = _CONV_ID, user: dict = Depends(require_user)):
    conv = auth.get_conversation(user["id"], conv_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation introuvable.")
    return conv


@app.put("/conversations/{conv_id}")
@limiter.limit("60/minute")
def put_conversation(request: Request, req: SaveConversationRequest, conv_id: str = _CONV_ID,
                     user: dict = Depends(require_user)):
    turns = [t.model_dump() for t in req.turns]
    if len(json.dumps(turns, ensure_ascii=False).encode()) > CONVERSATION_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Conversation trop longue.")
    auth.save_conversation(user["id"], conv_id, req.corpus, turns)
    return {"status": "ok"}


@app.delete("/conversations/{conv_id}")
def delete_conversation(conv_id: str = _CONV_ID, user: dict = Depends(require_user)):
    auth.delete_conversation(user["id"], conv_id)
    return {"status": "ok"}


@app.get("/push/vapid_public_key")
def push_vapid_public_key():
    return {"key": VAPID_PUBLIC_KEY}


@app.post("/push/subscribe")
def push_subscribe(req: PushSubscribeRequest, user: dict = Depends(require_user)):
    auth.add_push_subscription(user["id"], req.endpoint, req.keys.p256dh, req.keys.auth)
    return {"status": "ok"}


@app.delete("/push/subscribe")
def push_unsubscribe(endpoint: str, user: dict = Depends(require_user)):
    auth.remove_push_subscription(user["id"], endpoint)
    return {"status": "ok"}


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status": "ok",
        "articles": _article_count(),
        "llm": CHAT_MODEL,
        "llm_provider": llm.PROVIDER,
        "ollama": _ollama_reachable(),
        "last_article_date": _latest_article_date(),
        # Authoritative "today" for the frontend: a visitor's device clock
        # (timezone, DST, plain misconfiguration) is not a reliable source
        # for "is our data from today", so the dashboard compares against
        # this instead of new Date() — same anchoring principle as the rest
        # of the Gabon-anchored time handling in this file.
        "gabon_today": gabon_today().isoformat(),
    }


@app.get("/widget/summary")
def widget_summary():
    """Single-call data source for the iOS widget (ios/LeKiosqueWidget) — one
    request instead of the widget hitting multiple endpoints, since extension
    processes run under a tight memory/time budget. Reuses the same "today"
    window as the daily report (_collect_report) rather than recomputing it."""
    from collections import Counter

    _start, _now, rows = _collect_report(daily=True)

    # Yesterday's count, for a "today vs yesterday" comparison — deliberately
    # a 1-day window, not a weekly/corpus-wide average, so the large widget's
    # extra stat stays as fresh/recent as everything else on it.
    anchor_date = _start.date()
    yesterday_date = anchor_date - timedelta(days=1)
    _, _, two_day_rows = _collect_week(start=datetime.combine(yesterday_date, datetime.min.time()))
    yesterday_count = sum(1 for r in two_day_rows if r[0] == yesterday_date.isoformat())
    vs_yesterday_pct = (
        round((len(rows) - yesterday_count) / yesterday_count * 100) if yesterday_count > 0 else None
    )

    by_source = Counter(r[1] for r in rows if r[1])
    top_source = by_source.most_common(1)
    # "Non classé"/"Autres" are normalize_category's generic fallback buckets,
    # not real themes (same reasoning CustomTreemap in App.jsx uses to exclude
    # "Autres" from being followable) — surfacing one as "today's top theme"
    # would be meaningless, so they're excluded from the running here.
    GENERIC_THEME_BUCKETS = {"Non classé", "Autres"}
    by_theme = Counter(
        t for r in rows
        if (t := normalize_category(r[2], r[1])) not in GENERIC_THEME_BUCKETS
    )
    top_themes = by_theme.most_common(4)
    return {
        "articles": _article_count(),
        "last_article_date": _latest_article_date(),
        "gabon_today": gabon_today().isoformat(),
        "today_count": len(rows),
        "yesterday_count": yesterday_count,
        "vs_yesterday_pct": vs_yesterday_pct,
        "top_source": {"name": top_source[0][0], "count": top_source[0][1]} if top_source else None,
        # Top 4 (not just 1) so the widget can chart the spread, not just name
        # a winner.
        "themes": [{"name": n, "count": c} for n, c in top_themes],
    }


_HEADER_RE = re.compile(r"^(Titre|Catégorie|Date|Source)\s*:")


def _lede(doc: str, n: int = 260) -> str:
    """Opening of an article body: skips the indexing header and a short byline, cuts at a word."""
    paras = [p.strip() for p in doc.split("\n") if p.strip()]
    body = [p for p in paras if not _HEADER_RE.match(p)]
    if body and len(body[0]) < 70 and re.match(r"^(Par|By)\s", body[0]):
        body = body[1:]
    text = " ".join(body)
    if len(text) <= n:
        return text
    cut = text[:n].rsplit(" ", 1)[0].rstrip(",;:")
    return cut + "…"


@app.get("/today")
def today(per_theme: int = 6):
    """Front page of the web app: the latest covered day's articles, newest first, grouped by
    theme, each with a short lede. Same day window as the daily report (_collect_report)."""
    from collections import Counter

    start, _now, rows = _collect_report(daily=True)
    urls = [r[4] for r in rows if r[4]]
    items = []
    if urls:
        res = _collection.get(where={"source_url": {"$in": urls}}, include=["documents", "metadatas"])
        seen = set()
        for doc, m in zip(res["documents"], res["metadatas"]):
            if not m or m.get("chunk", 0) or m["source_url"] in seen:
                continue
            seen.add(m["source_url"])
            items.append({
                "title": m.get("title", ""),
                "source": m.get("source", ""),
                "theme": normalize_category(m.get("category"), m.get("source", "")),
                "url": m["source_url"],
                "time": str(m.get("published_time", "")),
                "lede": _lede(doc or ""),
            })
    items.sort(key=lambda a: a["time"], reverse=True)
    counts = Counter(a["theme"] for a in items)
    generic = {"Non classé", "Autres"}
    order = [t for t, _ in counts.most_common() if t not in generic] + [t for t in counts if t in generic]
    return {
        "date": start.date().isoformat(),
        "gabon_today": gabon_today().isoformat(),
        "count": len(items),
        "sources": len({a["source"] for a in items}),
        "latest": items[:12],
        # The lead theme gets twice the room: it fills the front page's main column
        "themes": [{"name": t, "count": counts[t], "articles": [a for a in items if a["theme"] == t][:per_theme * (2 if i == 0 else 1)]}
                   for i, t in enumerate(order)],
    }


def _code_title(meta: dict) -> str:
    label = CODE_LABELS.get(meta.get("code", ""), meta.get("code", ""))
    numero = meta.get("numero") or meta.get("type", "")
    return f"{label} · {numero}" if numero else label


# Which text a question names, by the words readers use for it
_CODE_HINTS = [
    (re.compile(r"finances?\W+(?:\w+\W+){0,3}2027|PLF\W*2027|2027\W+(?:\w+\W+){0,3}finances", re.I), "projet_loi_de_finances_2027"),
    (re.compile(r"finances?\W+(?:\w+\W+){0,3}2026|LFI?\W*2026|2026\W+(?:\w+\W+){0,3}finances", re.I), "loi_de_finances_2026"),
    (re.compile(r"code\s+p[ée]nal", re.I), "codes_penal"),
    (re.compile(r"code\s+minier", re.I), "codes_minier"),
    (re.compile(r"code\s+de\s+l.enfant", re.I), "codes_enfants"),
    (re.compile(r"hydrocarbures", re.I), "codes_hydrocarbures"),
    (re.compile(r"nationalit[ée]", re.I), "codes_nationalites"),
]
_ARTICLE_NAMED = re.compile(r"\bart(?:icle|\.)\s*(\d+)\s*(er|bis|ter|quater|quinquies)?\b", re.I)


def _named_code_articles(question: str) -> list[str]:
    """Ids of the articles a question names ("l'article 105 du projet de loi de
    finances 2027"), when it also names the text. The law's own article comes
    first; in a finance law, a quoted article of the tax code ("article 250 du
    CGI") is matched when the question says CGI or impôts."""
    codes = [code for rx, code in _CODE_HINTS if rx.search(question) and code in _CODES_INDEX]
    nums = _ARTICLE_NAMED.findall(question)
    if not codes or not nums:
        return []
    wants_cgi = bool(re.search(r"\bCGI\b|code\s+g[ée]n[ée]ral\s+des\s+imp[ôo]ts", question, re.I))
    ids: list[str] = []
    for code in codes[:1]:
        for num, suffix in nums:
            head = f"article {num}{(' ' + suffix.lower()) if suffix and suffix.lower() != 'er' else ''}"
            for e in _CODES_INDEX[code]:
                numero = (e.get("numero") or "").lower()
                is_cgi = "(" in numero
                if (numero == head or numero.startswith(head + " ")) and is_cgi == wants_cgi:
                    ids.append(e["id"])
    return ids[:3]


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
    # "Que prévoit l'article 105 du projet de loi de finances 2027 ?": the article
    # named leads, whatever the embedding finds closest
    named = _named_code_articles(question)
    if named:
        got = _codes_collection.get(ids=named, include=["documents", "metadatas"])
        by_id = dict(zip(got["ids"], zip(got["metadatas"], got["documents"])))
        for id_ in named:
            if id_ in by_id:
                meta, doc = by_id[id_]
                results.append(ArticleResult(
                    title=_code_title(meta), date="", source="Journal Officiel",
                    category=CODE_LABELS.get(meta.get("code", ""), meta.get("code", "")),
                    url=meta.get("source_url", ""), snippet=doc[:400] + "..." if len(doc) > 400 else doc,
                    distance=0.0, id=id_,
                ))
    for id_, meta, dist, doc in zip(
        raw["ids"][0], raw["metadatas"][0], raw["distances"][0], raw["documents"][0]
    ):
        if dist >= CODES_RELEVANCE_THRESHOLD or id_ in named:
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


@app.get("/codes/browse")
def codes_browse():
    """List available legal codes with their article counts, for the Codes
    de loi side panel's top-level navigation."""
    if _codes_collection is None:
        raise HTTPException(
            status_code=503,
            detail="Le corpus des codes juridiques n'est pas disponible.",
        )
    return {
        "codes": [
            {"code": code, "label": CODE_LABELS.get(code, code), "count": len(entries)}
            for code, entries in _CODES_INDEX.items()
        ]
    }


@app.get("/codes/browse/{code}")
def codes_browse_one(code: str):
    """Flat, source-ordered list of entries (numero/type/contexte) for one
    code — the frontend groups these into a Titre/Chapitre tree client-side."""
    entries = _CODES_INDEX.get(code)
    if entries is None:
        raise HTTPException(status_code=404, detail="Code juridique introuvable.")
    return {"code": code, "label": CODE_LABELS.get(code, code), "entries": entries}


@app.get("/codes/article/{article_id}")
def codes_article(article_id: str):
    """Full text of a single article/preambule entry, for the reading pane —
    a plain lookup, no LLM involved."""
    if _codes_collection is None:
        raise HTTPException(
            status_code=503,
            detail="Le corpus des codes juridiques n'est pas disponible.",
        )
    res = _codes_collection.get(ids=[article_id], include=["documents", "metadatas"])
    if not res["ids"]:
        raise HTTPException(status_code=404, detail="Article introuvable.")
    meta = res["metadatas"][0]
    code = meta.get("code", "")
    numero = meta.get("numero", "")
    contexte = meta.get("contexte", "")

    # The stored document is "title\n\ncontexte\n\ntexte" (create_codes_db.py's
    # assembly for embedding) — strip the parts the panel already shows as
    # separate fields (numero/contexte), leaving just the article body.
    body = res["documents"][0]
    title_parts = [p for p in [code, meta.get("type", ""), numero] if p]
    for line in filter(None, [" - ".join(title_parts) if title_parts else "", contexte]):
        if body.startswith(line):
            body = body[len(line):].lstrip("\n")

    return {
        "id": article_id,
        "numero": numero,
        "contexte": contexte,
        "code": code,
        "label": CODE_LABELS.get(code, code),
        "url": meta.get("source_url", ""),
        "text": body,
    }


@app.post("/search", response_model=SearchResponse)
@limiter.limit("30/minute")
def search(request: Request, req: SearchRequest):
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=422, detail="La question est vide.")

    # 1. Extract the time window the question refers to (None = not temporal).
    #    An explicit period (comparison mode) overrides text-based parsing.
    if bool(req.period_start) != bool(req.period_end):
        raise HTTPException(
            status_code=422,
            detail="period_start et period_end doivent être fournis ensemble.",
        )
    if req.period_start and req.period_end:
        try:
            start_dt = datetime.fromisoformat(req.period_start)
            end_dt = datetime.fromisoformat(req.period_end)
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail="period_start/period_end doivent être des dates ISO valides (AAAA-MM-JJ).",
            )
        # Inclusive end-of-day, matching how a "period" reads to a user
        end_dt = end_dt.replace(hour=23, minute=59, second=59)
        window = (gabon_timestamp(start_dt), gabon_timestamp(end_dt))
    else:
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
        ranked = temporal_rank(combined, now_ts=time.time())
        # Inside a window, recency alone let any article of the last day beat
        # an on-topic one from earlier that week ("la SEEG cette semaine"
        # returned none on the SEEG). Rank first those close to the best match;
        # a generic question matches everything about equally, so it keeps its
        # plain recency order. The rest only fills up to n_results.
        if ranked:
            best = min(d for _, d, _ in ranked)
            # Among the close ones, relevance leads and recency (over the
            # week, not two days) breaks near-ties
            close = temporal_rank(
                [x for x in ranked if x[1] <= best + WINDOW_RELEVANCE_MARGIN],
                now_ts=time.time(), sim_weight=0.85, rec_weight=0.15, half_life_days=7.0,
            )
            combined = close + [x for x in ranked if x[1] > best + WINDOW_RELEVANCE_MARGIN]
        else:
            combined = ranked
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


# Answer cache: repeated/duplicate questions (a second visitor asking the
# same thing, a refresh, a retry) shouldn't pay the full 1-3 minute local-LLM
# tax again. Keyed on the exact retrieved source set, not just the question
# text — if the corpus has moved on since the last identical question, the
# search step upstream would return different urls/ids and naturally miss
# this cache, so a stale answer never gets served as if it were current.
# Skipped for follow-ups (history present): the same question can have a
# different correct answer depending on what preceded it.
ANSWER_CACHE_TTL_S = 30 * 60
ANSWER_CACHE_MAX = 200
_answer_cache: dict[str, tuple[str, float]] = {}


def _answer_cache_key(corpus: str, question: str, urls: list[str], ids: list[str]) -> str:
    idents = sorted(ids if corpus == "codes" else urls)
    return f"{corpus}|{question.strip().lower()}|{'|'.join(idents)}"


def _answer_cache_get(key: str) -> str | None:
    hit = _answer_cache.get(key)
    if not hit:
        return None
    text, expires_at = hit
    if time.time() > expires_at:
        del _answer_cache[key]
        return None
    return text


def _answer_cache_put(key: str, text: str) -> None:
    if len(_answer_cache) >= ANSWER_CACHE_MAX:
        oldest_key = next(iter(_answer_cache))
        del _answer_cache[oldest_key]
    _answer_cache[key] = (text, time.time() + ANSWER_CACHE_TTL_S)


@app.post("/answer")
@limiter.limit("6/minute")
def answer(request: Request, req: AnswerRequest):
    cache_key = None
    if not req.history:
        cache_key = _answer_cache_key(req.corpus, req.question, req.urls, req.ids)
        cached = _answer_cache_get(cache_key)
        if cached is not None:
            return StreamingResponse(
                iter([cached]), media_type="text/plain",
                headers={"X-Answer-Source": "cache"},
            )
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
        chunks: list[str] = []
        try:
            for chunk in _llm.stream(messages):
                chunks.append(chunk.content)
                yield chunk.content
        except Exception as e:
            logger.error(f"LLM streaming error: {e}")
            yield (
                "\n\n[Erreur : la génération a été interrompue. "
                "Réessayez dans un instant.]"
            )
            return
        # Same truncation guard as the report cache: an unfinished answer
        # (aborted stream, context limit) must not get served back as if complete
        text = "".join(chunks)
        if cache_key and text and text[-1] in ".!?»)":
            _answer_cache_put(cache_key, text)

    return StreamingResponse(generate(), media_type="text/plain", headers={"X-Answer-Source": "fresh"})


_report_cache: dict = {
    "weekly": {"key": None, "text": None},
    "daily": {"key": None, "text": None},
}

# Dedicated LLM handle for the weekly report: hard output cap so generation stays
# bounded. Same num_ctx as the chat handle — a different value would force Ollama
# to reload the model between chat and report calls (minutes lost each switch).
REPORT_NUM_CTX = int(os.getenv("REPORT_NUM_CTX", str(CHAT_NUM_CTX)))
_report_llm = llm.chat_model(temperature=0.3, num_ctx=REPORT_NUM_CTX, max_tokens=2000)


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


# Canonical Python copy of frontend/src/App.jsx's normalizeCategory
# (App.jsx:2366-2397) — the JS version can't share this definition, so if the
# frontend's theme taxonomy changes, mirror it here too. Used by
# /widget/summary below and by push_notify.py (imported via `api.` rather
# than duplicated a second time).
MONO_THEME_SOURCES = {"gabonallsport": "Sport"}


def normalize_category(cat: "str | None", source: str) -> str:
    fallback = MONO_THEME_SOURCES.get(source)
    if not cat:
        return fallback or "Autres"
    c = re.sub(r"['\"«»]", "", cat.lower().strip())
    if "politique" in c: return "Politique"
    if "economie" in c or "économie" in c: return "Économie"
    if "societe" in c or "société" in c or "social" in c: return "Société"
    if "sport" in c or "foot" in c: return "Sport"
    if "justice" in c or "fait divers" in c or "faits_divers" in c or "faits divers" in c:
        return "Faits Divers / Justice"
    if "provinces" in c: return "Provinces"
    if "culture" in c or "musique" in c or "cinéma" in c: return "Culture"
    if "enviro" in c: return "Environnement"
    if "santé" in c or "sante" in c: return "Santé"
    if "admin" in c or "instit" in c: return "Administration"
    if "diplomatie" in c: return "Diplomatie"
    if "international" in c: return "International"
    if "education" in c or "formation" in c: return "Éducation"
    if "communication" in c or "médias" in c: return "Communication"
    if "ia" in c or "numérique" in c: return "IA / Numérique"
    if (re.match(r"^(a|à) la une", c) or c.startswith("actualit") or c in ("news", "infos")
            or "non class" in c or "uncategorized" in c):
        return fallback or "Non classé"
    return cat[:1].upper() + cat[1:]


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


def _maybe_cache_report(cache_key, text: str, kind: str = "weekly",
                        period_start: "date | None" = None,
                        period_end: "date | None" = None,
                        article_count: int = 0) -> None:
    # Only cache output that ends like a finished sentence — a stream cut
    # by the context limit would otherwise be served forever
    if text and text[-1] in ".!?»)":
        _report_cache[kind]["key"] = cache_key
        _report_cache[kind]["text"] = text
        if period_start and period_end:
            try:
                import report_archive
                report_archive.save_report(
                    kind, period_start.isoformat(), period_end.isoformat(),
                    article_count, text,
                )
            except Exception as e:
                # Archiving is a nice-to-have on top of a completed report —
                # never let it turn a successful generation into a 500
                logger.warning(f"/{kind}_report: archive save failed: {e}")
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
    # Told to the frontend via a header rather than inferred from timing: a
    # cache hit still has this window's articles available server-side, so
    # /daily_report/pdf can rebuild a matching PDF from it — unlike a report
    # reloaded from the archive (text only, no article list), where the PDF
    # link is correctly hidden. Two different guarantees; the UI should say
    # which one it's showing rather than making both look identical.
    if _report_cache[kind]["key"] == cache_key:
        return StreamingResponse(
            iter([_report_cache[kind]["text"]]), media_type="text/plain",
            headers={"X-Report-Source": "cache"},
        )

    messages, *_ = _weekly_messages(start, now, rows, daily=daily)

    def generate():
        chunks = []
        try:
            for chunk in _report_llm.stream(messages):
                chunks.append(chunk.content)
                yield chunk.content
            _maybe_cache_report(cache_key, "".join(chunks).strip(), kind=kind,
                                period_start=start.date(), period_end=now.date(),
                                article_count=len(rows))
        except Exception as e:
            logger.error(f"/{kind}_report LLM error: {e}")
            yield "\n\n[Erreur : la génération a été interrompue. Réessayez.]"

    return StreamingResponse(generate(), media_type="text/plain",
                             headers={"X-Report-Source": "fresh"})


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
        _maybe_cache_report(cache_key, text, kind=kind,
                           period_start=start.date(), period_end=now.date(),
                           article_count=len(rows))

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


@app.get("/reports/archive")
def reports_archive(kind: str | None = None, limit: int = 30):
    """Past generated reports, newest first (excerpt only — see /reports/archive/{id})."""
    if kind not in (None, "daily", "weekly"):
        raise HTTPException(status_code=422, detail="kind doit être 'daily' ou 'weekly'.")
    import report_archive
    return report_archive.list_reports(kind=kind, limit=min(max(limit, 1), 100))


@app.get("/reports/archive/{report_id}")
def reports_archive_one(report_id: int):
    import report_archive
    row = report_archive.get_report(report_id)
    if not row:
        raise HTTPException(status_code=404, detail="Rapport introuvable.")
    return row


if __name__ == "__main__":
    uvicorn.run("api:app", host="0.0.0.0", port=int(os.getenv("API_PORT", "8000")), reload=False)
