# Gabon Media RAG (Retrieval-Augmented Generation)

This project contains tools for scraping Gabonese news articles and legal codes to create a vector database (ChromaDB). This database can then be queried using Large Language Models via Ollama and LangChain to provide context-aware answers.

## Architecture

The project is split into distinct pipelines:

### 1. Newspaper Pipeline
Scrapes daily articles from **GabonReview** and **GabonMediaTime**, storing them as CSVs and embedding the text into a ChromaDB database.

👉 **[See the Newspaper Pipeline Documentation](scripts/newspaper_pipeline/README.md)**

### 2. Legal Codes Pipeline (WIP)
Scripts intended to scrape and parse legal documents from the Journal Officiel and other sources.
* `get_codes.py`
* `create_codes_db.py`
* `discover_jo.py`

## Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/VhinyMombo/newsdata.git
   cd newsdata
   ```

2. **Install dependencies:**
   *(Ensure you are using a Python virtual environment)*
   ```bash
   pip install -r requirements.txt
   ```

3. **Install Ollama:**
   This project relies on [Ollama](https://ollama.com/) for local LLM embeddings. After installing, pull the required model:
   ```bash
   ollama pull embeddinggemma
   ```

## Usage

### Updating the Newspaper Database
To fetch the latest X days of articles and rebuild the database:
```bash
# Scrape the last 3 days
./scripts/update_newspaper.sh 3
```

### Visualizing Embeddings
You can run a 2D PCA projection of the ChromaDB to interactively explore the vector space:
```bash
python scripts/plot_newspaper.py --question "Que dit l'opposition sur la transition?"
```
