# Le Kiosque

## Une plateforme souveraine d'intelligence documentaire pour la presse gabonaise

**Livre blanc · Version 2.0 · Juillet 2026**
Auteur : Vhiny Mombo

---

## Résumé exécutif

Le Kiosque est une plateforme qui agrège quotidiennement la presse en ligne gabonaise et la rend interrogeable en langage naturel. Un lecteur peut demander « Quelles sont les nouvelles du jour ? » ou « Que se passe-t-il avec la SEEG ? » et obtenir en quelques secondes une synthèse rédigée, datée et systématiquement sourcée, générée à partir des articles eux-mêmes, jamais à partir des connaissances générales du modèle. Un second corpus, les codes de loi gabonais du Journal Officiel, est interrogeable dans la même interface avec citation systématique des numéros d'articles.

Trois choix structurent le projet :

1. **La génération augmentée par récupération (RAG)** : chaque réponse est construite exclusivement à partir de documents réels retrouvés dans le corpus. Cette contrainte élimine le principal défaut des assistants IA génériques, l'invention de faits, et garantit la traçabilité de chaque affirmation vers sa source.
2. **La conscience du temps** : l'actualité est une matière périssable. Le Kiosque implémente un *RAG temporel* complet : extraction de fenêtres de dates depuis la question, filtrage par plage au niveau de l'index, et classement par score composite pertinence × fraîcheur.
3. **La souveraineté technologique** : l'intégralité de la chaîne (collecte, indexation, recherche, génération) s'exécute localement, sur une seule machine, avec des modèles open source. Aucune donnée ne transite par un service d'IA tiers, et le coût marginal d'une question est nul.

Le corpus presse couvre sept titres gabonais en ligne, soit plus de 10 200 articles collectés en continu depuis décembre 2025. Le corpus juridique compte 1 502 articles de loi issus de cinq codes en vigueur.

---

## 1. Contexte : une presse riche, un accès fragmenté

La presse en ligne gabonaise est vivante et diverse, mais son exploitation reste laborieuse. L'information est éclatée entre des sites indépendants, sans moteur de recherche transversal, sans archives structurées communes, et sans moyen simple de reconstituer la chronologie d'un dossier (une crise de l'eau, une loi de finances, une élection professionnelle) à travers plusieurs rédactions.

Les assistants IA grand public ne comblent ce vide qu'en partie. Équipés d'outils de recherche web, ils savent désormais consulter des sources en ligne et citer des liens. Mais leur couverture de la presse gabonaise reste tributaire de l'indexation des grands moteurs de recherche, qui référencent mal les sites à faible audience internationale ; ils échantillonnent quelques pages au moment de la question, sans corpus exhaustif ni archive (un article dépublié ou un site momentanément hors ligne sort de leur champ) ; ils n'offrent ni analyse transversale du corpus (volumes, thématiques, chronologies), ni contrôle du périmètre des sources ; et chaque question transite par une infrastructure étrangère, avec un coût à l'usage. Les moteurs de recherche classiques, eux, renvoient des liens, pas des réponses.

Le Kiosque occupe l'espace entre les deux : un corpus national exhaustif, maîtrisé, archivé et enrichi quotidiennement, interrogeable en langage naturel, dont chaque réponse est ancrée dans des documents identifiés.

---

## 2. La plateforme

**L'assistant conversationnel.** L'utilisateur pose ses questions en français et choisit son corpus (📰 Presse ou ⚖️ Codes de loi). Le système retrouve les documents pertinents, génère une synthèse en streaming, et affiche les sources directement sous chaque réponse (titre, journal ou code, date, lien vers l'original). La conversation est réellement conversationnelle : les questions de suivi (« et à Port-Gentil ? ») sont interprétées dans le contexte des échanges précédents, et l'historique survit au rechargement de la page.

**La carte sémantique.** Le corpus presse est projeté en deux ou trois dimensions : chaque point est un article, la proximité spatiale reflète la proximité de sens. Les grappes thématiques sont détectées automatiquement et nommées par le modèle de langage. Les articles retrouvés par une recherche s'illuminent sur la carte. La carte est masquable d'un clic pour les usages non techniques, préférence mémorisée par navigateur.

**Le tableau de bord statistique.** Volumes par rubrique et par journal, répartition thématique, couverture temporelle.

---

## 3. Architecture technique

### 3.1 Vue d'ensemble

```
Sites de presse (7 sources)                    Journal Officiel (7 codes)
        │  scraping quotidien parallèle                │  scraping ad hoc
        ▼                                              ▼
Google Sheets (dépôt central, dédoublonné par URL)   CSV locaux
        │  indexation incrémentale                     │
        ▼                                              ▼
newspaper_chroma_db (10 586 entrées)          codes_chroma_db (1 502 entrées)
   embeddings : embeddinggemma (Ollama)          même modèle d'embedding
        │                                              │
        └────────────────┬─────────────────────────────┘
                         ▼
        API FastAPI : /search, /answer, /health
           • RAG temporel (corpus presse)
           • prompts spécialisés par corpus
           • génération : qwen3.5:9b (Ollama), streaming
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
  Frontend React                   Export hors ligne
  (chat, carte, stats)             UMAP/PCA + HDBSCAN + thèmes LLM
```

Pile logicielle : Python 3.13, FastAPI + Uvicorn, ChromaDB (persistance locale), LangChain (liaison Ollama), React 19 + Vite, Plotly. Tous les paramètres sensibles (modèles, seuils, poids, port) sont pilotables par variables d'environnement.

### 3.2 Collecte

Sept scrapers spécialisés s'exécutent en parallèle chaque jour. Deux familles :

- **Sites WordPress à API REST ouverte** (Dépêches 241, 7 Jours Info) : interrogation directe de `/wp/v2/posts` avec filtre `after=<date>` côté serveur, 50 articles par requête, résolution des catégories via `/wp/v2/categories`. Un module partagé (`wp_rest_scraper.py`) factorise cette logique : ajouter une source WordPress coûte une quinzaine de lignes. Un rattrapage historique de 7 mois représente environ 30 requêtes.
- **Sites à parcours HTML** (GabonReview, GabonMediaTime, GabonActu, L'Union, Éthique Média) : pagination des pages de rubriques, extraction de la date via la balise `article:published_time`, arrêt après deux pages consécutives sans article dans la fenêtre cible.

Les articles normalisés (rubrique, titre, date ISO, URL, texte intégral) sont versés dans un dépôt central Google Sheets, un onglet par source, qui sert de couche d'audit humaine : le corpus brut est lisible et corrigeable. Le dédoublonnage par URL est appliqué à chaque étage (scraper, Sheets, indexation), ce qui rend toute la chaîne ré-exécutable sans effet de bord. Limite technique gérée : Google Sheets plafonne à 50 000 caractères par cellule ; les textes sont tronqués à 48 000 avec marqueur.

### 3.3 Indexation vectorielle

- **Modèle d'embedding** : `embeddinggemma` (open source, exécuté par Ollama), choisi pour son rapport qualité/coût en français. Il tronque au-delà d'environ 2 048 tokens, ce qui impose le découpage ci-dessous.
- **Chunking** : les articles de plus de 6 000 caractères sont découpés en chunks de 4 500 caractères avec recouvrement de 400, en privilégiant les frontières de paragraphes puis de phrases. Le chunk 0 conserve l'identifiant de base de l'article (hash MD5 de l'URL) ; les suivants reçoivent `<id>#N` et un en-tête synthétique portant le titre, pour rester interprétables isolément.
- **Métadonnées** : source, rubrique, titre, date ISO, et un horodatage numérique `published_ts` (epoch Unix). Cette double représentation existe parce que ChromaDB ne supporte les opérateurs de plage (`$gte`/`$lte`) que sur les nombres. Une migration a rétro-rempli le champ sur les 9 758 entrées antérieures, par mise à jour de métadonnées seule, sans re-vectorisation.
- **Indexation incrémentale** : seuls les articles absents de l'index sont vectorisés, par lots de 64 avec trois tentatives et backoff (l'API d'embedding locale peut échouer sur de gros lots). Une mise à jour quotidienne typique (30 à 50 articles) prend moins d'une minute.

### 3.4 RAG temporel

La similarité sémantique seule répond mal aux questions d'actualité : un article de fond vieux de six mois peut être plus « proche » de la question que la dépêche d'hier qui y répond réellement (*knowledge drift*). Le Kiosque traite le temps en trois étages :

**a) Extraction de fenêtre.** Un analyseur à règles (zéro appel LLM, latence nulle) classe l'intention temporelle :

| Déclencheur | Fenêtre |
|---|---|
| « aujourd'hui », « du jour », « en ce moment » | 48 h, ancrées sur le dernier article collecté |
| « hier » | depuis la veille minuit |
| « cette semaine », « récent », « actualité »… | 7 jours |
| « ce mois », « ces dernières semaines » | 30 jours |
| mois explicite (« en mars 2026 ») | le mois calendaire |
| intention prospective (« futur », « prochain », « prévu ») | 14 jours (les annonces vivent dans le récent) |

L'ancrage sur le dernier article collecté rend « les nouvelles du jour » robuste aux décalages de collecte : si le scraping n'a pas encore tourné, la fenêtre glisse sur la dernière journée couverte. Une version antérieure classifiait l'intention par appel au LLM ; elle ajoutait plusieurs secondes par recherche et a été remplacée par ces règles.

**b) Récupération fenêtrée.** La recherche vectorielle est contrainte par un filtre d'index `published_ts ∈ [début, fin]`, en récupérant jusqu'à 100 candidats dans la fenêtre (contre 30 hors mode temporel). L'implémentation initiale ratissait 2 000 candidats sur tout le corpus puis triait par date en Python ; le filtrage à l'index l'a remplacée.

**c) Classement par décote.** Les candidats sont ordonnés par :

```
score = 0,6 × similarité + 0,4 × fraîcheur
similarité = max(0 ; 1 − distance/2)
fraîcheur  = 0,5^(âge_en_jours / 2)        (demi-vie : 2 jours)
```

Un article très pertinent d'avant-hier peut ainsi devancer un article vaguement pertinent d'aujourd'hui, ce qu'un tri par date interdit. Poids et demi-vie sont réglables par variables d'environnement (`SIMILARITY_WEIGHT`, `RECENCY_WEIGHT`, `RECENCY_HALF_LIFE_DAYS`).

Les questions sans dimension temporelle suivent le chemin classique : recherche sémantique avec seuil de distance (1,7 pour la presse, 1,9 pour les codes, dont la formulation s'éloigne davantage de celle des requêtes).

### 3.5 Recherche et génération

**Deux endpoints découplés.** `/search` retourne les documents classés (titre, date, source, extrait, distance) ; `/answer` reçoit la question et les identifiants des documents retenus, recharge leur **texte intégral** côté serveur (jamais fourni par le client, qui ne pourrait envoyer que des extraits tronqués et serait manipulable), réassemble les chunks dans l'ordre en retirant les en-têtes synthétiques, et streame la synthèse. Chaque article est plafonné à 4 000 caractères de contexte ; la fenêtre du modèle est configurée à 16 384 tokens.

**Suivis conversationnels, aux deux étages.** À la récupération, une heuristique détecte les questions dépendantes du contexte (moins de cinq mots, connecteurs « et… », « mais… », pronoms, anaphores « cette affaire ») et vectorise alors la concaténation question précédente + question courante. À la génération, les trois derniers échanges sont rejoués comme tours de dialogue (réponses tronquées à 1 200 caractères). L'heuristique est volontairement conservatrice : un faux positif tirerait une question sans rapport dans l'embedding.

**Ingénierie de prompt pour petits modèles.** Trois enseignements empiriques, chacun issu d'un échec observé :

1. *Les injonctions contradictoires fabriquent des réponses.* Le prompt initial ordonnait « ne dis jamais que tu n'as pas d'information ». Face à une question sans réponse dans le corpus (« quel est le prochain déplacement du président ? »), le modèle détournait des articles voisins (horaires de trains) pour donner l'impression de répondre. La règle actuelle : réponse directe quand les articles répondent ; sinon le dire en une phrase, puis résumer ce qui s'en approche.
2. *La position de la question compte.* Les petits modèles pondèrent davantage la fin du prompt : la question apparaît en tête (avant les règles) et en rappel final (« Réponds uniquement à cette question, sur son sujet exact »).
3. *Les formules imposées contaminent.* Imposer un préfixe exact pour le cas « pas de réponse » a conduit le modèle à l'utiliser systématiquement, même quand les articles répondaient. La formulation conditionnelle explicite (« dans le cas normal… / dans le cas contraire… ») a corrigé le biais.

**Corpus juridique.** Prompt système distinct : citation obligatoire du numéro d'article pour chaque affirmation, interdiction de reformulation approximative des dispositions, aveu explicite lorsque les extraits ne couvrent pas la question, et mention finale de non-conseil juridique. Le contexte est rechargé par identifiant d'entrée (et non par URL : tous les articles d'un même code partagent la page du Journal Officiel).

### 3.6 Choix des modèles : mesures

Le modèle de génération est substituable par variable d'environnement. Mesures réalisées sur la machine de développement (Apple Silicon, inférence GPU Metal via Ollama), réponse complète sur les questions de test du projet :

| Modèle | Mode | Latence/réponse | Qualité observée |
|---|---|---|---|
| phi4-mini (3,8 B) | standard | ~13 s | Correcte ; fragile sur les nuances (sujet, intention) |
| qwen3.5:9b | thinking actif | 116 à 614 s | Excellente mais inutilisable en interactif |
| **qwen3.5:9b** | **thinking désactivé** | **10 à 14 s** | **Excellente : sujet exact, dates justes, honnêteté** |
| qwen3:4b | thinking actif | 65 à 83 s | Très bonne ; option « raisonnement » économique |
| qwen3:4b | thinking désactivé | non exploitable | Le template Ollama laisse fuir le raisonnement |

Enseignement principal : les modèles à raisonnement (famille Qwen3) génèrent par défaut des milliers de tokens de réflexion invisibles, multipliant la latence par 10 à 40 pour un gain marginal en synthèse documentaire. L'API les détecte par préfixe de nom et désactive le raisonnement (`reasoning=False`), réactivable par `OLLAMA_REASONING=true` pour les usages analytiques. Configuration par défaut retenue : **qwen3.5:9b sans thinking**, dont la qualité s'approche des modèles hébergés pour ce cas d'usage, à latence interactive (streaming : premier token en 2 à 5 s).

### 3.7 Exploration visuelle

Un traitement hors ligne extrait les vecteurs de l'index, calcule quatre projections (PCA et UMAP, en 2D et 3D ; UMAP avec `n_neighbors=15`, `min_dist=0.1`), détecte les grappes par HDBSCAN dans l'espace UMAP 3D (taille minimale adaptative selon le corpus), puis fait nommer chaque grappe par le LLM à partir d'un échantillon de titres. Le tout est exporté en JSON statique consommé par le frontend (Plotly, clic sur un point = ouverture de l'article).

---

## 4. Souveraineté et IA locale

Le choix d'une exécution intégralement locale n'est pas un détail d'implémentation, c'est une thèse :

- **Confidentialité** : les questions des utilisateurs, qui révèlent des centres d'intérêt politiques, économiques ou judiciaires, ne quittent jamais la machine.
- **Indépendance** : aucune API d'IA tierce, aucun quota, aucune exposition aux évolutions tarifaires ou contractuelles d'un fournisseur. Une fois la collecte effectuée, le système fonctionne hors ligne.
- **Coût** : coût marginal nul par question. L'ensemble tourne sur une machine de bureau ; l'inférence GPU (Metal) y est native, sans matériel dédié.
- **Reproductibilité** : modèles, base vectorielle et pile applicative intégralement open source. Le dispositif est réplicable pour n'importe quel corpus de presse national.

Le Kiosque démontre qu'une infrastructure d'intelligence documentaire de presse peut être construite et opérée localement, à coût quasi nul, pour un écosystème médiatique qui n'est prioritaire pour aucun grand acteur technologique.

---

## 5. État des corpus

**Presse** (10 202 articles uniques, 10 586 entrées indexées) :

| Source | Couverture | Articles |
|---|---|---|
| GabonMediaTime | déc. 2025 → aujourd'hui | ~3 090 |
| GabonReview | déc. 2025 → aujourd'hui | ~2 540 |
| L'Union | déc. 2025 → aujourd'hui | ~2 380 |
| GabonActu | déc. 2025 → aujourd'hui | ~1 400 |
| Dépêches 241 | déc. 2025 → aujourd'hui (rattrapé) | ~740 |
| 7 Jours Info | juil. 2026 → aujourd'hui (rattrapage possible) | ~30 |
| Éthique Média Gabon | juil. 2026 → aujourd'hui (rattrapage possible) | ~15 |

**Codes juridiques** (1 502 articles de loi, granularité : l'article) : Code pénal, Code minier, Code des hydrocarbures, Code de l'enfant, Code de la nationalité. Référencés mais restant à intégrer : Code du travail, Code pénal modifié.

Le pipeline complet (7 scrapers parallèles → Sheets → indexation incrémentale → export des projections) s'exécute quotidiennement en une commande et notifie son avancement.

---

## 6. Limites connues

- **Pas d'évaluation formalisée.** La qualité est validée empiriquement sur des questions de test ; un banc d'évaluation (questions datées annotées, métriques de précision temporelle et de fidélité) reste à construire.
- **Recherche purement vectorielle.** Les noms propres rares et sigles exacts bénéficieraient d'une recherche hybride (BM25 + vecteurs).
- **Heuristique de suivi conservatrice.** Un suivi formulé comme une question autonome peut échapper à l'enrichissement contextuel à la récupération ; le modèle de génération, qui voit l'historique, compense en général.
- **Décote temporelle limitée au mode temporel.** Les questions sans marqueur de temps (« où en est le chantier X ? ») suivent le chemin purement sémantique et peuvent remonter du contenu ancien ; une décote légère généralisée est à l'étude.
- **Mono-machine, usage privé.** Déploiement public conditionné à : limitation de débit, CORS restreint, compression de l'export JSON (10,6 Mo), hébergement dimensionné pour le modèle choisi.

---

## 7. Feuille de route

- **Recherche hybride** BM25 + vecteurs pour les entités nommées.
- **Corpus** : rattrapage historique des nouvelles sources (l'API REST WordPress le rend trivial), intégration du Code du travail, exploration systématique du Journal Officiel.
- **Croisement presse ↔ droit** : « que dit la loi sur ce dont parle cet article ? », la fonctionnalité différenciante que la double indexation rend possible.
- **Évaluation** : jeu de test de questions datées, mesure de la précision temporelle et de la fidélité des synthèses.
- **Déploiement** : exposition maîtrisée (tunnel sécurisé depuis la machine locale, puis serveur dédié), avec les prérequis de la section 6.

---

## 8. Conclusion

Le Kiosque démontre qu'avec des composants entièrement open source et une machine ordinaire, un écosystème de presse national peut être doté d'une infrastructure moderne d'accès à l'information : recherche sémantique, synthèses sourcées, conscience du temps, corpus juridique, exploration visuelle. La méthode (corpus vivant, RAG temporel, exécution souveraine) est transposable à d'autres pays, d'autres corpus, d'autres échelles.

L'information de qualité existe ; la presse gabonaise la produit chaque jour. Le Kiosque travaille à ce qu'elle soit trouvable, vérifiable et mémorisée.

---

*Document produit dans le cadre du projet Le Kiosque. Contact : Vhiny Mombo.*
