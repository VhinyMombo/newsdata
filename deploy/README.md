# Mettre Le Kiosque en ligne gratuitement

Un serveur Oracle Cloud « Always Free » fait tout tourner : l'API, la recherche
(embeddinggemma dans Ollama), la base ChromaDB, les collectes et les comptes
rendus programmés. Les réponses de l'assistant sont rédigées par l'offre
gratuite de Gemini (Flash Lite), avec un petit modèle Qwen local en secours.
Caddy sert le site en HTTPS sur
`lekiosque.hodologic.fr` avec un certificat Let's Encrypt renouvelé seul.

```
visiteur ──443──▶ Caddy ──▶ nginx (site + /api) ──▶ FastAPI ──▶ Ollama (embeddings)
                                                      │
                                                      └──▶ Gemini Flash Lite (réponses, Qwen local en secours)
cron ──▶ pipeline (collectes, ChromaDB, data.json, comptes rendus)
```

## 1. Ce que vous faites vous-même

Ces étapes demandent votre identité ou vos identifiants : elles ne peuvent pas
être faites à votre place.

1. **Compte Oracle Cloud** sur <https://signup.oraclecloud.com>. Une carte est
   demandée pour vérifier l'identité, sans débit sur l'offre gratuite. Le choix
   de la *région d'origine* est définitif : prenez-en une proche du Gabon et
   de l'Europe (Paris, Marseille ou Francfort).
2. **Créer la machine** (Compute › Instances › Create instance) :
   - image **Ubuntu 24.04** ;
   - forme **VM.Standard.A1.Flex** (Ampere), **4 OCPU, 24 Go** de mémoire ;
   - volume de démarrage de **100 Go** (jusqu'à 200 Go restent gratuits) ;
   - collez votre clé SSH publique (`cat ~/.ssh/id_ed25519.pub`).

   Si Oracle répond *Out of capacity*, réessayez plus tard ou dans un autre
   « availability domain » : les machines Ampere gratuites sont souvent pleines.
3. **Ouvrir les ports 80 et 443** : Networking › Virtual cloud networks › votre
   réseau › Security Lists › Default › *Add ingress rules*, source
   `0.0.0.0/0`, TCP, ports `80,443`.
4. **Clé Gemini** sur <https://aistudio.google.com/apikey>. Regardez dans AI
   Studio le quota gratuit affiché pour votre projet : il a beaucoup baissé en
   2026. Plus tard, une clé **Groq** sur <https://console.groq.com/keys> servira
   de secours quand le quota Gemini est épuisé.

Donnez ensuite l'adresse IP publique de la machine : le reste peut se faire
depuis le Mac.

## 2. Préparer le serveur

```bash
ssh ubuntu@IP
sudo timedatectl set-timezone Africa/Libreville
# Les images Ubuntu d'Oracle bloquent tout sauf SSH dans iptables
sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -j ACCEPT
sudo iptables -I INPUT 6 -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu   # puis se reconnecter
```

## 3. Envoyer le code, les données et les secrets

Depuis le Mac, dans le dossier du projet :

```bash
rsync -az --info=progress2 \
  --exclude .venv --exclude node_modules --exclude .git --exclude logs \
  --exclude '*.log' --exclude graphify-out --exclude ios \
  ./ ubuntu@IP:lekiosque/
```

Cela copie aussi `newspaper_chroma_db/`, `codes_chroma_db/`, `data/`,
`frontend/public/data.json`, `.env` (clés VAPID) et `credentials.json`
(Google Sheets). Les bases SQLite (`auth.db`, `reports_archive.db`) vont dans
le volume Docker à l'étape suivante.

Sur le serveur, créez `.env.docker` à partir de `.env.docker.example` :

```bash
# Assistant : Gemini Flash Lite, réponse complète en 1 à 2 s
LLM_PROVIDER=gemini
GEMINI_API_KEY=…
LLM_MODEL=gemini-flash-lite-latest
LLM_REASONING_EFFORT=minimal
# Secours quand Gemini refuse : Qwen dans le conteneur Ollama (45 à 75 s sur processeur)
LLM_FALLBACK_PROVIDER=ollama
LLM_FALLBACK_MODEL=qwen3:1.7b
# Tâches de masse du pipeline sur le modèle local
LLM_BATCH_PROVIDER=ollama
LLM_BATCH_MODEL=qwen3:1.7b
# Noms des thèmes de la carte : par lots de vingt sur Flash Lite
LLM_NAMING_PROVIDER=gemini
LLM_NAMING_MODEL=gemini-flash-lite-latest
LLM_NAMING_REASONING_EFFORT=minimal
```

Ne prenez pas `gemini-3.8-flash` (le modèle par défaut de `llm.py`) pour
l'assistant sur l'offre gratuite : Google le limite à 20 requêtes par jour
pour tout le projet (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`),
puis chaque question bascule sur Qwen. Flash Lite a un quota plus large, mais
partagé entre l'assistant et le nommage des thèmes (une vingtaine de requêtes
par collecte). Flash Lite refuse `LLM_REASONING_EFFORT=none` : utilisez
`minimal`.

## 4. Démarrer

```bash
cd ~/lekiosque && mkdir -p logs
# The containers run as uid 10001: give them the data folders, keep group write for ubuntu
sudo chown -R 10001:1000 newspaper_chroma_db codes_chroma_db data frontend/public
sudo chmod -R g+rwX newspaper_chroma_db codes_chroma_db data frontend/public
DC="docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --profile ollama"
$DC up -d --build
$DC exec ollama ollama pull embeddinggemma
$DC exec ollama ollama pull qwen3:1.7b   # modèle de secours
# Comptes et archive des comptes rendus, copiés une fois dans le volume
docker cp auth.db "$($DC ps -q api)":/data/auth.db
docker cp reports_archive.db "$($DC ps -q api)":/data/reports_archive.db
# docker cp keeps the Mac's owner: hand the files to the container user (uid 10001)
$DC exec -u root api chown -R 10001:10001 /data
$DC restart api
crontab deploy/crontab
```

## 5. L'adresse

Chez Hostinger, zone DNS de `hodologic.fr` : un enregistrement **A**
`lekiosque` vers l'IP du serveur. Caddy obtient le certificat dès que le nom
pointe vers la machine.

## Vérifier

```bash
curl -s https://lekiosque.hodologic.fr/api/health
$DC logs -f api caddy
```

`/health` indique le fournisseur (`llm_provider`) et le modèle utilisés.

## Changer de modèle

Tout se règle dans `.env.docker`, puis `$DC up -d api` :

| Pour | Réglage |
|---|---|
| Groq seul | `LLM_PROVIDER=groq`, `GROQ_API_KEY=…` |
| Gemini, Groq en secours | ajouter `LLM_FALLBACK_PROVIDER=groq` et `GROQ_API_KEY=…` |
| Gemini Flash Lite (réglage actuel) | `LLM_MODEL=gemini-flash-lite-latest`, `LLM_REASONING_EFFORT=minimal` |
| Gemini Flash, plus fouillé | `LLM_MODEL=gemini-3.8-flash`, `LLM_REASONING_EFFORT=none` : 20 requêtes par jour en gratuit, à réserver à une clé avec facturation |
| Revenir au modèle local | `LLM_PROVIDER=ollama` : 45 à 75 s par réponse avec qwen3:1.7b sur 2 processeurs, plusieurs minutes avec qwen3.5:9b |

## Statistiques de visite (Umami)

Umami tourne à côté du site, sur `stats.hodologic.fr`, sans cookies. Il faut un
enregistrement **A** `stats` vers l'IP du serveur, puis, sur le serveur :

```bash
cd ~/lekiosque
# Secrets générés sur place, jamais dans le dépôt
umask 077
P=$(openssl rand -hex 24)
printf "POSTGRES_PASSWORD=%s\nDATABASE_URL=postgresql://umami:%s@umami-db:5432/umami\nAPP_SECRET=%s\n" \
  "$P" "$P" "$(openssl rand -hex 32)" > .env.umami
$DC up -d umami-db umami && $DC up -d --force-recreate caddy
```

Umami crée un compte `admin` / `umami` : changez ce mot de passe tout de suite
(Paramètres › Profil), le tableau de bord étant public. Ajoutez ensuite le site
`lekiosque.hodologic.fr` et reportez son identifiant dans `data-website-id`
(`frontend/index.html`).

Le site envoie, en plus des pages vues : `question` (rubrique, origine),
`comparaison`, `installation-demandee`, `installation`, `inscription` et `pdf`.
Chaque visite porte l'étiquette (*tag*) `navigateur` ou `application`, selon
qu'elle vient du navigateur ou de l'application installée.

## Sauvegardes

Chaque nuit à 3 h 30, `deploy/backup.sh` range dans `~/backups/` une archive
`lekiosque-AAAA-MM-JJ.tar.gz` (lisible par `ubuntu` seul), gardée 14 jours :
les comptes, sujets suivis et conversations (`auth.db`), l'archive des comptes
rendus (`reports_archive.db`), les statistiques Umami (`umami.sql.gz`) et les
secrets (`.env*`, `credentials.json`). Les articles n'y sont pas : la collecte
les reconstruit depuis les Google Sheets. Le Mac en garde une copie
(`~/Backups/lekiosque`, récupérée chaque jour à 10 h par `deploy/pull-backups.sh`,
installé en `~/Backups/pull-lekiosque.sh` avec un agent launchd).

Restaurer, sur le serveur :

```bash
mkdir /tmp/r && tar -xzf ~/backups/lekiosque-AAAA-MM-JJ.tar.gz -C /tmp/r
docker cp /tmp/r/auth.db "$($DC ps -q api)":/data/auth.db
docker cp /tmp/r/reports_archive.db "$($DC ps -q api)":/data/reports_archive.db
$DC exec -u root api chown -R 10001:10001 /data && $DC restart api
gunzip -c /tmp/r/umami.sql.gz | $DC exec -T umami-db psql -U umami -d umami
```

## Connexion avec Google et Facebook

`oauth.py` mène la connexion côté serveur, sans SDK dans la page. Clés dans
`.env.docker` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FACEBOOK_APP_ID`,
`FACEBOOK_APP_SECRET`), puis `$DC up -d api`. Adresses de retour déclarées chez
chacun : `https://lekiosque.hodologic.fr/api/auth/{google,facebook}/callback`.

- Google : projet « Le Kiosque » (Google Auth Platform), publié, marque vérifiée.
- Facebook : app « Le Kiosque » (ID 1888717179172677), non publiée tant que Meta
  n'a pas fait la vérification d'entreprise et l'examen de l'app. D'ici là le
  bouton n'apparaît qu'aux testeurs, qui ouvrent une fois `#/tester-facebook`.
  Après validation : `FACEBOOK_LIVE=1` dans `.env.docker`, puis `$DC up -d api`.

Depuis l'app installée, la page du fournisseur s'ouvre dans une fenêtre à part :
l'app attend le résultat (`/auth/app-wait`) au lieu d'être redirigée.
