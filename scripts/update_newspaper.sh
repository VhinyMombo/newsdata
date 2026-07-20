#!/bin/bash
# ============================================================
#  Pipeline: scrape newspaper articles → build ChromaDB
#
#  Usage:
#    ./scripts/update_newspaper.sh          # last 3 days (default)
#    ./scripts/update_newspaper.sh 7        # last 7 days
#    ./scripts/update_newspaper.sh 20       # last 20 days
# ============================================================

set -e

# Notify on error
function on_error() {
    osascript -e 'display notification "⚠️ Pipeline failed! An error occurred during scraping. Check the logs." with title "Le Kiosque"' || true
}
trap on_error ERR

# Accept both "update_newspaper.sh 7" and "update_newspaper.sh --days 7"
if [ "$1" = "--days" ]; then
    DAYS="${2:-3}"
else
    DAYS="${1:-3}"
fi
if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
    echo "Usage: $0 [N | --days N]   (N = number of days to scrape)"
    exit 1
fi
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$DIR/.venv/bin/python"
# Stream python output live into the log files (no block buffering)
export PYTHONUNBUFFERED=1

echo "============================================"
echo "  Newspaper Pipeline — last $DAYS days"
echo "  Start Time: $(date)"
echo "============================================"
echo ""

# Trigger macOS desktop notification for start
osascript -e 'display notification "Pipeline started! Scraping articles for the last '"$DAYS"' days..." with title "Le Kiosque"' || true



# Step 1: Scrape all sources in parallel
# Format: "script_name:log/tab_name:Display Name"
SCRAPERS=(
    "scrape_gabon_review.py:gabonreview:GabonReview"
    "scrape_gabon_media_time.py:gabonmediatime:GabonMediaTime"
    "scrape_gabon_actu.py:gabonactu:GabonActu"
    "scrape_lunion.py:lunion:L'Union"
    "scrape_depeches241.py:depeches241:Dépêches 241"
    "scrape_7joursinfo.py:7joursinfo:7 Jours Info"
    "scrape_ethiquemedia.py:ethiquemediagabon:Éthique Média"
    "scrape_focusgroupemedia.py:focusgroupemedia:Focus Groupe Média"
    "scrape_gabonallsport.py:gabonallsport:Gabon All Sport"
    "scrape_gabonquotidien.py:gabonquotidien:Gabon Quotidien"
    "scrape_directinfosgabon.py:directinfosgabon:Direct Infos Gabon"
    "scrape_insidenews241.py:insidenews241:Inside News 241"
    "scrape_kongossanews.py:kongossanews:Kongossa News"
)

osascript -e 'display notification "Scraping all sources in parallel..." with title "Le Kiosque"' || true
echo "📰 [1/3] Scraping ${#SCRAPERS[@]} sources in parallel..."

PIDS=()
for entry in "${SCRAPERS[@]}"; do
    IFS=':' read -r script tab label <<< "$entry"
    $PYTHON "$DIR/scripts/newspaper_pipeline/$script" --days "$DAYS" > "/tmp/$tab.log" 2>&1 &
    PIDS+=($!)
done

echo "   → ${#PIDS[@]} scrapers running in background"
echo "   → Logs: /tmp/[source].log"

# Wait for all to finish; any failure aborts the pipeline
for i in "${!SCRAPERS[@]}"; do
    IFS=':' read -r script tab label <<< "${SCRAPERS[$i]}"
    wait "${PIDS[$i]}" || { echo "❌ $label failed"; cat "/tmp/$tab.log"; exit 1; }
    echo "   ✓ $label"
done

echo "✅ All scraping finished successfully."
echo ""

# Step 7: Rebuild ChromaDB
osascript -e 'display notification "Building ChromaDB vector database..." with title "Le Kiosque"' || true
echo "🗄️  [2/3] Building ChromaDB from Google Sheets..."
$PYTHON "$DIR/scripts/newspaper_pipeline/create_newspaper_db.py"
echo ""

# Step 8: Export embeddings for the frontend visualization
osascript -e 'display notification "Exporting embeddings for visualization..." with title "Le Kiosque"' || true
echo "📊 [3/3] Exporting embeddings for visualization..."
$PYTHON "$DIR/scripts/export_embeddings.py"
echo ""

echo "============================================"
echo "✅ Pipeline complete!"
echo "  End Time: $(date)"
echo "============================================"

# Trigger macOS desktop notification
osascript -e 'display notification "Pipeline completed successfully! New articles have been scraped and the database is updated." with title "Le Kiosque"' || true



