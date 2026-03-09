from pathlib import Path
import numpy as np
import matplotlib.pyplot as plt
from sklearn.decomposition import PCA
import chromadb
import plotly.express as px
import pandas as pd
import umap
from langchain_ollama.embeddings import OllamaEmbeddings
import os 
import plotly.graph_objects as go





PERSIST_DIR = str(Path(__file__).parent.parent / "codes_chroma_db")
COLLECTION_NAME = "codes_gabon"

client = chromadb.PersistentClient(path=PERSIST_DIR)
collection = client.get_collection(name=COLLECTION_NAME)


# Pull everything (or use limit by slicing ids)
data = collection.get(include=["embeddings", "metadatas", "documents"])


kinds = [meta["kind"] for meta in data["metadatas"]]
## make line breaks in documents after 60 characters
# documents = [doc.replace("\n", "<br>") for doc in data["documents"]]
documents = [
    "<br>".join(doc[i:i+60] for i in range(0, len(doc), 60))
    for doc in data["documents"]
]


print(documents)

X = np.array(data["embeddings"], dtype=np.float32)




# xy = PCA(n_components=2).fit_transform(X)
# xy_df = pd.DataFrame(xy, columns=["PC1", "PC2"])
# xy_df["kind"] = kinds
# xy_df["document"] = documents
# fig = px.scatter(xy_df, x="PC1", y="PC2", color="kind", hover_data=["document"])
# fig.show()

## 3D
# xy = PCA(n_components=3).fit_transform(X)
# xy_df = pd.DataFrame(xy, columns=["PC1", "PC2", "PC3"])
# xy_df["kind"] = kinds
# xy_df["document"] = documents
# ## REDUCE SIZE OF POINT

# fig = px.scatter_3d(xy_df, x="PC1", y="PC2", z="PC3", color="kind", hover_data=["document"])
# fig.update_traces(marker=dict(size=3))
# fig.show()



umap_model = umap.UMAP(
    n_components=2,
    n_neighbors=15,
    min_dist=0.1,
    metric="cosine",
    random_state=42
)

xy = umap_model.fit_transform(X)

# Build dataframe
xy_df = pd.DataFrame(xy, columns=["UMAP1", "UMAP2"])
xy_df["kind"] = kinds
xy_df["document"] = documents

# Plot
fig = px.scatter(
    xy_df,
    x="UMAP1",
    y="UMAP2",
    color="kind",
    hover_data=["document"]
)

# fig.update_traces(marker=dict(size=3, opacity=0.8))

fig.show()


embedding = OllamaEmbeddings(model=os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma"))

question = "Comment faire pour exproprier?"

q_emb = np.array(embedding.embed_query(question), dtype=np.float32).reshape(1, -1)
q_xy = umap_model.transform(q_emb)[0]  # shape: (2,)

# 4) Add query point
fig.add_trace(
    go.Scatter(
        x=[q_xy[0]],
        y=[q_xy[1]],
        mode="markers+text",
        text=["QUERY"],
        textposition="top center",
        marker=dict(size=14, symbol="x"),
        name="query",
        hovertext=[question],
        hoverinfo="text",
    )
)

fig.update_layout(
    title="UMAP projection of document embeddings + query",
    xaxis_title="UMAP1",
    yaxis_title="UMAP2",
)

fig.show()





# # Fit UMAP
# umap_model = umap.UMAP(
#     n_components=3,
#     n_neighbors=15,
#     min_dist=0.1,
#     metric="cosine",
#     random_state=42
# )

# xy = umap_model.fit_transform(X)

# # Build dataframe
# xy_df = pd.DataFrame(xy, columns=["UMAP1", "UMAP2", "UMAP3"])
# xy_df["kind"] = kinds
# xy_df["document"] = documents

# # Plot
# fig = px.scatter_3d(
#     xy_df,
#     x="UMAP1",
#     y="UMAP2",
#     z="UMAP3",
#     color="kind",
#     hover_data=["document"]
# )

# fig.update_traces(marker=dict(size=3, opacity=0.8))

# fig.show()