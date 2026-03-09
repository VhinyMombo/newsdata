# Newspaper Scraping Pipeline

This directory contains scripts to scrape Gabonese newspaper articles and build a Chroma vector database for use in Retrieval-Augmented Generation (RAG).

## Prerequisites

Before running the pipeline (specifically the ChromaDB building step), you must have [Ollama](https://ollama.com/) installed and running locally, as well as the required embedding model (default is `embeddinggemma`).

```bash
# Pull the default embedding model
ollama pull embeddinggemma
```

## Overview

The pipeline extracts articles from two sources:
1. **GabonReview** (`scrape_gabon_review.py`)
2. **GabonMediaTime** (`scrape_gabon_media_time.py`)

It then combines them into a ChromaDB collection named `newspaper_gabon` using `create_newspaper_db.py`. 

The data is saved to:
* **Raw CSV files:** `Newspaperdata/` (in the project root)
* **Vector DB:** `newspaper_chroma_db/` (in the project root)

## Automated Pipeline (Recommended)

The easiest way to update the database is using the shell script located in the parent `scripts/` folder. It runs both scrapers and automatically rebuilds the embeddings.

```bash
# Scrape the last 3 days (default)
./scripts/update_newspaper.sh

# Scrape the last 7 days
./scripts/update_newspaper.sh 7

# Scrape the last 30 days
./scripts/update_newspaper.sh 30
```

## Manual Usage

You can also run the scripts individually if you only want to update one source or change the default categories. 

*(Execute these commands from the root `rag/` directory)*

### 1. Scrape GabonReview
```bash
python scripts/newspaper_pipeline/scrape_gabon_review.py --days 3
```
*Optional arguments:* `--categories politique economie ...`

### 2. Scrape GabonMediaTime
```bash
python scripts/newspaper_pipeline/scrape_gabon_media_time.py --days 3
```
*Optional arguments:* `--categories actualites/politique actualites/economie ...`

### 3. Rebuild ChromaDB
```bash
# Deletes the old database and creates a new one from all CSVs in Newspaperdata/
python scripts/newspaper_pipeline/create_newspaper_db.py --reset
```

## Visualizing the DB

To generate a 2D interactive projection (UMAP or PCA) of the articles in the database:
```bash
python scripts/plot_newspaper.py --question "Que dit l'opposition sur la transition?"
```
