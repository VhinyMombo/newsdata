import os
from pathlib import Path

ROOT_DIR = Path(__file__).parent.parent   # project root (rag/)

from numpy import void

from langchain_chroma import Chroma
from langchain_core.prompts import ChatPromptTemplate
from langchain_ollama.llms import OllamaLLM
from langchain_ollama.embeddings import OllamaEmbeddings

# model = OllamaLLM(model="qwen3-vl")
model = OllamaLLM(model="llama3")


template = """
Vous êtes un juriste expert en droit.

Vous devez répondre uniquement à partir du contexte fourni.
N'utilisez aucune connaissance externe.
Ne faites aucune supposition.
Ne complétez pas avec vos connaissances personnelles.

Si l'information nécessaire n'apparaît pas clairement dans le contexte, répondez exactement, sans rien ajouter d'autre :
Je ne sais pas.

ATTENTION :
- Si la réponse est inconnue ou incertaine, vous devez répondre UNIQUEMENT par : Je ne sais pas.
- Dans ce cas, NE DONNEZ AUCUNE EXPLICATION, AUCUNE RAISON, AUCUNE FORMULE JURIDIQUE.
- Ne reformulez pas, ne justifiez pas, n'expliquez pas pourquoi vous ne savez pas.

Si, et seulement si, la réponse est clairement présente dans le contexte, alors :
- Basez votre réponse uniquement sur les éléments juridiques présents dans le contexte.
- Votre réponse DOIT toujours :
  - citer explicitement le ou les articles pertinents, sous la forme : « Selon l'article [NUMÉRO] du [NOM DU CODE], ... » ;
  - si plusieurs articles sont concernés, les citer tous : « Selon les articles [NUMÉRO(S)] du [NOM DU CODE], ... ».

Dans ce cas, formatez votre réponse ainsi :

1. Formule juridique obligatoire :
   - Exemple : « Selon l'article 5 du Code minier, ... »
2. Réponse détaillée en français clair, en restant fidèle au texte.

Si le contexte contient les métadonnées `code` et `article`, utilisez-les pour construire cette formule.

Contexte :
{context}

Question :
{question}
"""

prompt = ChatPromptTemplate.from_template(template)
chain = prompt | model

persist_dir = ROOT_DIR / "codes_chroma_db"
if not persist_dir.exists():
    raise FileNotFoundError(
        "Chroma DB not found. Build it first by running:\n"
        "  python scripts/create_codes_db.py --reset"
    )

embedding = OllamaEmbeddings(model=os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma"))
vector_store = Chroma(
    collection_name="codes_gabon",
    embedding_function=embedding,
    persist_directory=str(persist_dir),
)



while True:
    question = input("Question:  (q pour quitter) \n\n")
    if question == "q":
        break
    docs = vector_store.similarity_search(question, k=4)

    context_chunks = []
    for idx, d in enumerate(docs, start=1):
        m = d.metadata or {}
        header = (
            f"[DOC {idx}] "
            f"code={m.get('code', '')} | "
            f"type={m.get('type', '')} | "
            f"article={m.get('numero', '')} | "
            f"url={m.get('source_url', '')}"
        )
        context_chunks.append(header + "\n" + d.page_content)

    context = "\n\n".join(context_chunks)
    result = chain.invoke({"context": context, "question": question})
    print("\n\n")
    print("#########################")

    print(result)

    print("#########################")


# question = "Que dit le code sur l'expropriation ? en francais "


# docs = vector_store.similarity_search(question, k=4)
# context = "\n\n".join(d.page_content for d in docs)

# result = chain.invoke({"context": context, "question": question})

# print(result)




