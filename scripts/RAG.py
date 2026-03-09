from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Iterable, Optional

import pandas as pd
from langchain_chroma import Chroma
from langchain_core.prompts import ChatPromptTemplate
from langchain_ollama.llms import OllamaLLM
from langchain_ollama.embeddings import OllamaEmbeddings
from langchain_core.documents import Document



class RAG:
    def __init__(
        self,
        model_id: str,
        embedding_id: str,
        path_vector_db: str,
        collection_id: str,
    ):
        self.model_id = model_id
        self.embedding_id = embedding_id
        self.persist_directory = Path(path_vector_db)
        self.collection_id = collection_id

        # Store LLM + embedding as attributes
        self.llm = OllamaLLM(model=self.model_id)
        self.embedding = OllamaEmbeddings(
            model=os.getenv("OLLAMA_EMBED_MODEL", self.embedding_id)
        )

        # Load existing DB if present; otherwise keep None until built
        if self.persist_directory.exists():
            self.vector_store = Chroma(
                collection_name=self.collection_id,
                embedding_function=self.embedding,
                persist_directory=str(self.persist_directory),
            )
        else:
            self.vector_store = None

    # ----------------------------
    # Build / rebuild vector DB
    # ----------------------------
    def build_vector_db(
        self,
        csv_paths: Iterable[str | Path],
        reset: bool = False,
        max_rows: Optional[int] = None,
    ) -> None:
        csv_paths = [Path(p) for p in csv_paths]

        if reset and self.persist_directory.exists():
            shutil.rmtree(self.persist_directory)

        docs = self._load_codes_csvs(csv_paths=csv_paths, max_rows=max_rows)

        self.vector_store = Chroma.from_documents(
            documents=docs,
            embedding=self.embedding,
            collection_name=self.collection_id,
            persist_directory=str(self.persist_directory),
        )

    # ----------------------------
    # Retrieval
    # ----------------------------
    def retrieve(self, question: str, k: int = 4) -> list[Document]:
        if self.vector_store is None:
            raise RuntimeError(
                "Chroma DB not initialized. Call build_vector_db(...) first "
                "or point path_vector_db to an existing persisted DB."
            )
        return self.vector_store.similarity_search(question, k=k)

    # ----------------------------
    # Simple RAG answer
    # ----------------------------
    def answer(self, question: str, k: int = 4) -> dict:

        
        while True:
            question = input("Question:  (q pour quitter) \n\n")
            if question == "q":
                break

            docs = self.retrieve(question, k=k)

            context = "\n\n---\n\n".join(
                f"[{i+1}] {d.page_content}\nSOURCE: {d.metadata.get('source_url', '')}"
                for i, d in enumerate(docs)
            )

            prompt = f"""Vous êtes un juriste assistant. Répondez en vous basant uniquement sur le contexte.
            Si la réponse n'est pas dans le contexte, répondez exactement : Je ne sais pas.
            Contexte:
            {context}

            Question:
            {question}
            
             """

            response = self.llm.invoke(prompt)

            return {
                "question": question,
                "answer": response,
                "docs": docs,
            }

    # ----------------------------
    # Internal helpers
    # ----------------------------
    @staticmethod
    def _normalize_str(value: object) -> str:
        if value is None:
            return ""
        s = str(value).strip()
        return "" if s.lower() == "nan" else s

    def _load_codes_csvs(self, csv_paths: list[Path], max_rows: Optional[int]) -> list[Document]:
        required = {"code", "source_url", "type", "numero", "contexte", "texte"}
        docs: list[Document] = []

        remaining = max_rows
        for path in csv_paths:
            if not path.exists():
                raise FileNotFoundError(f"CSV file not found: {path}")

            df = pd.read_csv(path)

            missing = sorted(required - set(df.columns))
            if missing:
                raise ValueError(f"{path} missing required columns: {missing}")

            if remaining is not None:
                if remaining <= 0:
                    break
                df = df.head(remaining)
                remaining -= len(df)

            for i, row in df.iterrows():
                code = self._normalize_str(row.get("code"))
                numero = self._normalize_str(row.get("numero"))
                type_ = self._normalize_str(row.get("type"))
                contexte = self._normalize_str(row.get("contexte"))
                texte = self._normalize_str(row.get("texte"))
                source_url = self._normalize_str(row.get("source_url"))

                if not texte:
                    continue

                title_parts = [p for p in [code, type_, numero] if p]
                title = " - ".join(title_parts)

                parts = []
                if title:
                    parts.append(title)
                if contexte:
                    parts.append(contexte)
                parts.append(texte)

                page_content = "\n\n".join(parts)

                metadata = {
                    "code": code,
                    "numero": numero,
                    "type": type_,
                    "contexte": contexte,
                    "source_url": source_url,
                    "source_file": str(path),
                    "row": int(i),
                    "kind": code or "code",
                }

                docs.append(Document(page_content=page_content, metadata=metadata))

        if not docs:
            raise ValueError("No documents created from CSVs (all rows empty?).")

        # Deduplicate identical snippets
        deduped: list[Document] = []
        seen: set[tuple[str, str, str, str]] = set()
        for d in docs:
            m = d.metadata or {}
            key = (
                str(m.get("code", "")),
                str(m.get("type", "")),
                str(m.get("numero", "")),
                d.page_content,
            )
            if key in seen:
                continue
            seen.add(key)
            deduped.append(d)

        return deduped