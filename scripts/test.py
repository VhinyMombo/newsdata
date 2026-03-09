from pathlib import Path
from RAG import RAG

ROOT_DIR = Path(__file__).parent.parent   # project root (rag/)

rag = RAG(
    model_id="llama3",              # or your Ollama LLM model
    embedding_id="embeddinggemma",    # your embedding model
    path_vector_db=str(ROOT_DIR / "codes_chroma_db"),
    collection_id="codes_gabon",
)

# Build / rebuild from CSVs
# rag.build_vector_db(
#     csv_paths=["./tous_les_codes.csv"],
#     reset=False,
# )

# Ask
out = rag.answer("peine pour un violeur", k=5)
print(out["answer"])