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



# Step 1: Scrape GabonReview
osascript -e 'display notification "Scraping GabonReview..." with title "Le Kiosque"' || true
echo "📰 [1/6] Scraping GabonReview..."
$PYTHON "$DIR/scripts/newspaper_pipeline/scrape_gabon_review.py" --days "$DAYS"
echo ""

# Step 2: Scrape GabonMediaTime
osascript -e 'display notification "Scraping GabonMediaTime..." with title "Le Kiosque"' || true
echo "📰 [2/6] Scraping GabonMediaTime..."
$PYTHON "$DIR/scripts/newspaper_pipeline/scrape_gabon_media_time.py" --days "$DAYS"
echo ""

# Step 3: Scrape GabonActu
osascript -e 'display notification "Scraping GabonActu..." with title "Le Kiosque"' || true
echo "📰 [3/6] Scraping GabonActu..."
$PYTHON "$DIR/scripts/newspaper_pipeline/scrape_gabon_actu.py" --days "$DAYS"
echo ""

# Step 4: Scrape L'Union
osascript -e "display notification \"Scraping L'Union...\" with title \"Le Kiosque\"" || true
echo "📰 [4/6] Scraping L'Union..."
$PYTHON "$DIR/scripts/newspaper_pipeline/scrape_lunion.py" --days "$DAYS"
echo ""

# Step 5: Rebuild ChromaDB
osascript -e 'display notification "Building ChromaDB vector database..." with title "Le Kiosque"' || true
echo "🗄️  [5/6] Building ChromaDB..."
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


