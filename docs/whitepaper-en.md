# Le Kiosque

## A sovereign document-intelligence platform for the Gabonese press

**White paper · Version 2.0 · July 2026**
Author: Vhiny Mombo

---

## Executive summary

Le Kiosque is a platform that aggregates Gabon's online press daily and makes it queryable in natural language. A reader can ask "What's in the news today?" or "What is happening with SEEG?" and receive, within seconds, a written synthesis that is dated and systematically sourced, generated from the articles themselves and never from the model's general knowledge. A second corpus, the Gabonese legal codes from the Journal Officiel, is queryable through the same interface with systematic citation of article numbers.

Three choices structure the project:

1. **Retrieval-augmented generation (RAG)**: every answer is built exclusively from real documents retrieved from the corpus. This constraint eliminates the main failure mode of generic AI assistants, invented facts, and guarantees that every claim is traceable to its source.
2. **Time awareness**: news is perishable material. Le Kiosque implements full *temporal RAG*: date-window extraction from the question, range filtering at the index level, and ranking by a composite relevance × freshness score.
3. **Technological sovereignty**: the entire chain (collection, indexing, retrieval, generation) runs locally, on a single machine, with open-source models. No data transits through a third-party AI service, and the marginal cost of a question is zero.

The press corpus covers seven Gabonese online outlets, totaling more than 10,200 articles collected continuously since December 2025. The legal corpus counts 1,502 law articles from five codes currently in force.

---

## 1. Context: a rich press, fragmented access

Gabon's online press is lively and diverse, but working with it is laborious. Information is scattered across independent sites, with no cross-outlet search engine, no shared structured archive, and no simple way to reconstruct the timeline of an ongoing story (a water crisis, a finance bill, a professional election) across multiple newsrooms.

Mainstream AI assistants only partially fill this gap. Equipped with web-search tools, they can now consult online sources and cite links. But their coverage of the Gabonese press remains hostage to how well major search engines index low-international-traffic sites; they sample a handful of pages at question time, with no exhaustive corpus and no archive (an unpublished article or a temporarily offline site falls out of their reach); they offer neither corpus-wide analysis (volumes, themes, timelines) nor control over the source perimeter; and every question transits through foreign infrastructure, at a per-use cost. Conventional search engines, for their part, return links rather than answers.

Le Kiosque occupies the space between the two: an exhaustive, controlled, archived national corpus enriched daily, queryable in natural language, with every answer anchored in identified documents.

---

## 2. The platform

**The conversational assistant.** Users ask questions in French and pick their corpus (📰 Press or ⚖️ Legal codes). The system retrieves the relevant documents, streams a written synthesis, and displays the sources directly below each answer (title, outlet or code, date, link to the original). The conversation is genuinely conversational: follow-up questions ("and in Port-Gentil?") are interpreted in the context of previous exchanges, and the history survives page reloads.

**The semantic map.** The press corpus is projected into two or three dimensions: each point is an article, and spatial proximity reflects proximity of meaning. Thematic clusters are detected automatically and named by the language model. Articles retrieved by a search light up on the map. The map can be hidden with one click for non-technical use, with the preference remembered per browser.

**The statistics dashboard.** Volumes by section and by outlet, thematic distribution, temporal coverage.

---

## 3. Technical architecture

### 3.1 Overview

```
News sites (7 sources)                        Journal Officiel (7 codes)
        │  daily parallel scraping                     │  ad hoc scraping
        ▼                                              ▼
Google Sheets (central repository, URL-deduplicated) local CSVs
        │  incremental indexing                        │
        ▼                                              ▼
newspaper_chroma_db (10,586 entries)          codes_chroma_db (1,502 entries)
   embeddings: embeddinggemma (Ollama)           same embedding model
        │                                              │
        └────────────────┬─────────────────────────────┘
                         ▼
        FastAPI service: /search, /answer, /health
           • temporal RAG (press corpus)
           • per-corpus specialized prompts
           • generation: qwen3.5:9b (Ollama), streaming
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
  React frontend                   Offline export
  (chat, map, stats)               UMAP/PCA + HDBSCAN + LLM themes
```

Software stack: Python 3.13, FastAPI + Uvicorn, ChromaDB (local persistence), LangChain (Ollama binding), React 19 + Vite, Plotly. Every sensitive parameter (models, thresholds, weights, port) is controlled through environment variables.

### 3.2 Collection

Seven specialized scrapers run in parallel every day. Two families:

- **WordPress sites with an open REST API** (Dépêches 241, 7 Jours Info): direct queries to `/wp/v2/posts` with a server-side `after=<date>` filter, 50 posts per request, category resolution via `/wp/v2/categories`. A shared module (`wp_rest_scraper.py`) factors this logic out: adding a WordPress source costs about fifteen lines. A 7-month historical backfill amounts to roughly 30 requests.
- **HTML-crawled sites** (GabonReview, GabonMediaTime, GabonActu, L'Union, Éthique Média): pagination through category pages, date extraction from the `article:published_time` meta tag, stopping after two consecutive pages with no article inside the target window.

Normalized articles (section, title, ISO date, URL, full text) are stored in a central Google Sheets repository, one tab per source, which acts as a human audit layer: the raw corpus is readable and correctable. URL deduplication is applied at every stage (scraper, Sheets, indexing), making the whole chain safely re-runnable. One handled limitation: Google Sheets caps cells at 50,000 characters; texts are truncated at 48,000 with a marker.

### 3.3 Vector indexing

- **Embedding model**: `embeddinggemma` (open source, served by Ollama), chosen for its quality-to-cost ratio in French. It truncates beyond roughly 2,048 tokens, which motivates the chunking below.
- **Chunking**: articles longer than 6,000 characters are split into 4,500-character chunks with a 400-character overlap, preferring paragraph then sentence boundaries. Chunk 0 keeps the article's base ID (MD5 hash of the URL); subsequent chunks get `<id>#N` and a synthetic header carrying the title, so they remain interpretable in isolation.
- **Metadata**: source, section, title, ISO date, and a numeric timestamp `published_ts` (Unix epoch). This dual representation exists because ChromaDB only supports range operators (`$gte`/`$lte`) on numbers. A migration backfilled the field onto the 9,758 pre-existing entries through a metadata-only update, with no re-embedding.
- **Incremental indexing**: only articles absent from the index are embedded, in batches of 64 with three retries and backoff (the local embedding API can fail on large batches). A typical daily update (30 to 50 articles) takes under a minute.

### 3.4 Temporal RAG

Semantic similarity alone answers news questions poorly: a six-month-old feature piece can be "closer" to the question than yesterday's dispatch that actually answers it (*knowledge drift*). Le Kiosque handles time in three stages:

**a) Window extraction.** A rule-based parser (zero LLM calls, zero latency) classifies temporal intent:

| Trigger | Window |
|---|---|
| "today", "right now" | 48 h, anchored to the most recent collected article |
| "yesterday" | since yesterday midnight |
| "this week", "recent", "news"… | 7 days |
| "this month", "recent weeks" | 30 days |
| explicit month ("in March 2026") | the calendar month |
| prospective intent ("future", "next", "planned") | 14 days (announcements live in recent news) |

Anchoring to the most recent collected article makes "today's news" robust to collection lag: if scraping has not yet run, the window slides onto the last covered day. An earlier version classified intent with an LLM call; it added several seconds per search and was replaced by these rules.

**b) Windowed retrieval.** Vector search is constrained by an index-level filter `published_ts ∈ [start, end]`, fetching up to 100 candidates inside the window (versus 30 outside temporal mode). The initial implementation raked 2,000 candidates across the whole corpus and sorted by date in Python; index-level filtering replaced it.

**c) Decay ranking.** Candidates are ordered by:

```
score = 0.6 × similarity + 0.4 × freshness
similarity = max(0; 1 − distance/2)
freshness  = 0.5^(age_in_days / 2)        (half-life: 2 days)
```

A highly relevant article from two days ago can thus outrank a vaguely relevant one from today, which a plain date sort forbids. Weights and half-life are tunable through environment variables (`SIMILARITY_WEIGHT`, `RECENCY_WEIGHT`, `RECENCY_HALF_LIFE_DAYS`).

Questions with no temporal dimension follow the classic path: semantic search with a distance threshold (1.7 for press, 1.9 for legal codes, whose wording sits farther from query phrasing).

### 3.5 Retrieval and generation

**Two decoupled endpoints.** `/search` returns ranked documents (title, date, source, snippet, distance); `/answer` receives the question and the identifiers of the retained documents, reloads their **full text** server-side (never supplied by the client, which could only send truncated snippets and would be manipulable), reassembles chunks in order while stripping synthetic headers, and streams the synthesis. Each article is capped at 4,000 characters of context; the model's window is configured at 16,384 tokens.

**Conversational follow-ups, at both stages.** At retrieval, a heuristic detects context-dependent questions (fewer than five words, connectors like "and…", "but…", pronouns, anaphora such as "this affair") and then embeds the concatenation of previous + current question. At generation, the last three exchanges are replayed as dialogue turns (answers truncated at 1,200 characters). The heuristic is deliberately conservative: a false positive would drag an unrelated question into the embedding.

**Prompt engineering for small models.** Three empirical lessons, each drawn from an observed failure:

1. *Contradictory injunctions fabricate answers.* The initial prompt ordered "never say you have no information". Faced with a question whose answer was absent from the corpus ("what is the president's next trip?"), the model repurposed adjacent articles (train schedules) to appear to answer. The current rule: answer directly when the articles answer; otherwise say so in one sentence, then summarize the closest available material.
2. *Question position matters.* Small models weight the end of the prompt more: the question appears first (before the rules) and as a final reminder ("Answer only this question, on its exact subject").
3. *Mandated phrasings contaminate.* Imposing an exact prefix for the "no answer" case led the model to use it systematically, even when the articles did answer. Explicit conditional phrasing ("in the normal case… / otherwise…") corrected the bias.

**Legal corpus.** Distinct system prompt: mandatory citation of the article number for every claim, no approximate rephrasing of provisions, explicit acknowledgment when the extracts do not cover the question, and a closing not-legal-advice notice. Context is reloaded by entry identifier (not by URL: all articles of a given code share the same Journal Officiel page).

### 3.6 Model selection: measurements

The generation model is swappable through an environment variable. Measurements on the development machine (Apple Silicon, GPU Metal inference via Ollama), full answer on the project's test questions:

| Model | Mode | Latency/answer | Observed quality |
|---|---|---|---|
| phi4-mini (3.8 B) | standard | ~13 s | Decent; fragile on nuances (subject, intent) |
| qwen3.5:9b | thinking on | 116 to 614 s | Excellent but unusable interactively |
| **qwen3.5:9b** | **thinking off** | **10 to 14 s** | **Excellent: exact subject, correct dates, honesty** |
| qwen3:4b | thinking on | 65 to 83 s | Very good; budget "reasoning" option |
| qwen3:4b | thinking off | unusable | The Ollama template leaks the reasoning |

Main lesson: reasoning models (Qwen3 family) generate thousands of hidden thinking tokens by default, multiplying latency by 10 to 40 for marginal gain in document synthesis. The API detects them by name prefix and disables reasoning (`reasoning=False`), re-enable-able with `OLLAMA_REASONING=true` for analytical use. Default configuration retained: **qwen3.5:9b without thinking**, whose quality approaches hosted models for this use case, at interactive latency (streaming: first token in 2 to 5 s).

### 3.7 Visual exploration

An offline job extracts the vectors from the index, computes four projections (PCA and UMAP, in 2D and 3D; UMAP with `n_neighbors=15`, `min_dist=0.1`), detects clusters with HDBSCAN in the UMAP-3D space (adaptive minimum cluster size), then has the LLM name each cluster from a sample of its titles. Everything is exported as static JSON consumed by the frontend (Plotly; clicking a point opens the article).

---

## 4. Sovereignty and local AI

Running everything locally is not an implementation detail; it is a thesis:

- **Privacy**: users' questions, which reveal political, economic, and judicial interests, never leave the machine.
- **Independence**: no third-party AI API, no quota, no exposure to a provider's pricing or contractual changes. Once collection has run, the system works offline.
- **Cost**: zero marginal cost per question. Everything runs on a desktop machine; GPU inference (Metal) is native, with no dedicated hardware.
- **Reproducibility**: models, vector database, and application stack are fully open source. The setup is replicable for any national press corpus.

Le Kiosque demonstrates that a press document-intelligence infrastructure can be built and operated locally, at near-zero cost, for a media ecosystem that is a priority for no major technology player.

---

## 5. Corpus status

**Press** (10,202 unique articles, 10,586 indexed entries):

| Source | Coverage | Articles |
|---|---|---|
| GabonMediaTime | Dec 2025 → today | ~3,090 |
| GabonReview | Dec 2025 → today | ~2,540 |
| L'Union | Dec 2025 → today | ~2,380 |
| GabonActu | Dec 2025 → today | ~1,400 |
| Dépêches 241 | Dec 2025 → today (backfilled) | ~740 |
| 7 Jours Info | Jul 2026 → today (backfill available) | ~30 |
| Éthique Média Gabon | Jul 2026 → today (backfill available) | ~15 |

**Legal codes** (1,502 law articles, granularity: the article): Penal Code, Mining Code, Hydrocarbons Code, Children's Code, Nationality Code. Referenced but pending integration: Labor Code, amended Penal Code.

The complete pipeline (7 parallel scrapers → Sheets → incremental indexing → projection export) runs daily as a single command and reports its progress.

---

## 6. Known limitations

- **No formalized evaluation.** Quality is validated empirically on test questions; an evaluation bench (annotated dated questions, temporal-accuracy and faithfulness metrics) remains to be built.
- **Purely vector search.** Rare proper nouns and exact acronyms would benefit from hybrid retrieval (BM25 + vectors).
- **Conservative follow-up heuristic.** A follow-up phrased as a standalone question can escape contextual enrichment at retrieval; the generation model, which sees the history, usually compensates.
- **Temporal decay limited to temporal mode.** Questions with no time marker ("where does project X stand?") follow the purely semantic path and can surface old content; a light generalized decay is under consideration.
- **Single machine, private use.** Public deployment is conditional on: rate limiting, restricted CORS, compression of the JSON export (10.6 MB), and hosting sized for the chosen model.

---

## 7. Roadmap

- **Hybrid retrieval**: BM25 + vectors for named entities.
- **Corpus**: historical backfill of the new sources (trivial thanks to the WordPress REST API), integration of the Labor Code, systematic exploration of the Journal Officiel.
- **Press ↔ law cross-referencing**: "what does the law say about what this article reports?", the differentiating feature that dual indexing makes possible.
- **Evaluation**: a test set of dated questions, measuring temporal accuracy and synthesis faithfulness.
- **Deployment**: controlled exposure (secure tunnel from the local machine, then a dedicated server), with the prerequisites of section 6.

---

## 8. Conclusion

Le Kiosque demonstrates that with fully open-source components and an ordinary machine, a national press ecosystem can be equipped with modern information-access infrastructure: semantic search, sourced syntheses, time awareness, a legal corpus, visual exploration. The method (a living corpus, temporal RAG, sovereign execution) is transposable to other countries, other corpora, other scales.

Quality information exists; the Gabonese press produces it every day. Le Kiosque works to make it findable, verifiable, and remembered.

---

*Document produced as part of the Le Kiosque project. Contact: Vhiny Mombo.*
