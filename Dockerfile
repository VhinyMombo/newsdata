# syntax=docker/dockerfile:1.7
#
# Le Kiosque — API + pipeline image.
#
# One image serves both roles: `uvicorn api:app` (the `api` service) and the
# scraper/embedding pipeline (`scripts/update_newspaper.sh`, the `pipeline`
# service). They share every dependency — chromadb, langchain-ollama, pandas —
# so a second image would only duplicate a 1 GB layer stack.
#
# Build: docker compose build api
# Run:   docker compose up -d api web

# ---------------------------------------------------------------- builder ---
FROM python:3.13-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# Build-only toolchain: a few wheels (pywebpush's cryptography backend,
# chromadb's hnswlib) still compile from source on arm64.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Self-contained venv, copied wholesale into the runtime stage — keeps the
# compiler and its headers out of the final image.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip && pip install -r requirements.txt

# French stopwords for push_notify.py's title keyword extraction. Baked in at
# build time so a container never reaches out to nltk.org on first request.
# The target dir has to exist and be on nltk.data.path first — nltk 3.9+
# rejects an unknown -d path outright ("Security Violation: Unauthorized path").
RUN mkdir -p /opt/nltk_data \
    && NLTK_DATA=/opt/nltk_data python -c "import nltk; nltk.download('stopwords')"

# ---------------------------------------------------------------- runtime ---
FROM python:3.13-slim AS runtime

# libcairo2  — cairosvg, which lets-plot's ggsave() shells into for PNG output
# fonts-*    — report figures ask for "Helvetica"; fontconfig maps that to
#              Liberation Sans. Without them every chart label renders as tofu.
# curl       — container healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
        libcairo2 \
        fonts-liberation \
        fonts-dejavu-core \
        curl \
        tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/nltk_data /opt/nltk_data

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NLTK_DATA=/opt/nltk_data \
    API_PORT=8000

# Written state lives on a volume, not in the image layer (see compose).
ENV AUTH_DB_PATH=/data/auth.db \
    REPORTS_DB_PATH=/data/reports_archive.db

# Ollama runs outside this container — compose overrides for a linux host.
ENV OLLAMA_HOST=http://host.docker.internal:11434

# matplotlib/wordcloud need a writable config dir under the non-root user.
ENV MPLCONFIGDIR=/tmp/matplotlib

WORKDIR /app

# Non-root: the API accepts unauthenticated public traffic.
RUN useradd --create-home --uid 10001 kiosque \
    && mkdir -p /data /app/newspaper_chroma_db /app/codes_chroma_db \
    && chown -R kiosque:kiosque /data /app

COPY --chown=kiosque:kiosque api.py auth.py llm.py report_archive.py report_pdf.py \
     lekiosque_theme.py push_notify.py mailer.py oauth.py ./
COPY --chown=kiosque:kiosque scripts/ ./scripts/
COPY --chown=kiosque:kiosque assets/report/ ./assets/report/

USER kiosque

EXPOSE 8000

# tini reaps the parallel scraper children update_newspaper.sh forks.
ENTRYPOINT ["/usr/bin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${API_PORT}/health" || exit 1

CMD ["sh", "-c", "exec uvicorn api:app --host 0.0.0.0 --port ${API_PORT}"]
