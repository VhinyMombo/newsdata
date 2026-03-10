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

DAYS="${1:-3}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$DIR/.venv/bin/python"

echo "============================================"
echo "  Newspaper Pipeline — last $DAYS days"
echo "============================================"
echo ""

# Step 1: Scrape GabonReview
echo "📰 [1/3] Scraping GabonReview..."
$PYTHON "$DIR/scripts/newspaper_pipeline/scrape_gabon_review.py" --days "$DAYS"
echo ""

# Step 2: Scrape GabonMediaTime
echo "📰 [2/3] Scraping GabonMediaTime..."
$PYTHON "$DIR/scripts/newspaper_pipeline/scrape_gabon_media_time.py" --days "$DAYS"
echo ""

# Step 3: Rebuild ChromaDB
echo "🗄️  [3/3] Building ChromaDB..."
$PYTHON "$DIR/scripts/newspaper_pipeline/create_newspaper_db.py"
echo ""

echo "============================================"
echo "✅ Pipeline complete!"
echo "============================================"
