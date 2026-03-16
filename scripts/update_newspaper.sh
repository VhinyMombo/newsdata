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

DAYS="${1:-3}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$DIR/.venv/bin/python"

echo "============================================"
echo "  Newspaper Pipeline — last $DAYS days"
echo "  Start Time: $(date)"
echo "============================================"
echo ""

# Trigger macOS desktop notification for start
osascript -e 'display notification "Pipeline started! Scraping articles for the last '"$DAYS"' days..." with title "Le Kiosque"' || true



# Step 1-4: Scrape all sources in parallel
osascript -e 'display notification "Scraping all sources in parallel..." with title "Le Kiosque"' || true
echo "📰 [1-4/6] Scraping GabonReview, GabonMediaTime, GabonActu, and L'Union in parallel..."

$PYTHON "$DIR/scripts/newspaper_pipeline/scrape_gabon_review.py"     --days "$DAYS" > /tmp/gabonreview.log 2>&1 &
PID1=$!
$PYTHON "$DIR/scripts/newspaper_pipeline/scrape_gabon_media_time.py" --days "$DAYS" > /tmp/gabonmediatime.log 2>&1 &
PID2=$!
$PYTHON "$DIR/scripts/newspaper_pipeline/scrape_gabon_actu.py"       --days "$DAYS" > /tmp/gabonactu.log 2>&1 &
PID3=$!
$PYTHON "$DIR/scripts/newspaper_pipeline/scrape_lunion.py"           --days "$DAYS" > /tmp/lunion.log 2>&1 &
PID4=$!

echo "   → Scrapers running in background (PIDs: $PID1 $PID2 $PID3 $PID4)"
echo "   → Logs: /tmp/[source].log"

# Wait for all to finish
wait $PID1 || { echo "❌ GabonReview failed"; cat /tmp/gabonreview.log; exit 1; }
wait $PID2 || { echo "❌ GabonMediaTime failed"; cat /tmp/gabonmediatime.log; exit 1; }
wait $PID3 || { echo "❌ GabonActu failed"; cat /tmp/gabonactu.log; exit 1; }
wait $PID4 || { echo "❌ L'Union failed"; cat /tmp/lunion.log; exit 1; }

echo "✅ All scraping finished successfully."
echo ""

# Step 5: Rebuild ChromaDB
osascript -e 'display notification "Building ChromaDB vector database..." with title "Le Kiosque"' || true
echo "🗄️  [5/6] Building ChromaDB from Google Sheets..."
$PYTHON "$DIR/scripts/newspaper_pipeline/create_newspaper_db.py"
echo ""

# Step 6: Export embeddings for the frontend visualization
osascript -e 'display notification "Exporting embeddings for visualization..." with title "Le Kiosque"' || true
echo "📊 [6/6] Exporting embeddings for visualization..."
$PYTHON "$DIR/scripts/export_embeddings.py"
echo ""

echo "============================================"
echo "✅ Pipeline complete!"
echo "  End Time: $(date)"
echo "============================================"

# Trigger macOS desktop notification
osascript -e 'display notification "Pipeline completed successfully! New articles have been scraped and the database is updated." with title "Le Kiosque"' || true



