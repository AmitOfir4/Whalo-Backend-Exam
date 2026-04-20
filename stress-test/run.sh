#!/usr/bin/env bash
# stress-test/run.sh — convenience wrapper around k6
#
# Usage:
#   ./stress-test/run.sh              # run with default settings
#   ./stress-test/run.sh --summary    # also write summary.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STRESS_SCRIPT="$SCRIPT_DIR/stress.js"
SUMMARY_FILE="$SCRIPT_DIR/results/summary-$(date +%Y%m%d-%H%M%S).json"

if ! command -v k6 &>/dev/null; then
  echo "k6 not found. Install it with: brew install k6"
  exit 1
fi

echo "======================================================"
echo "  Whalo Backend — k6 Stress Test (500 VU / 5 min)"
echo "======================================================"
echo ""
echo "Services expected:"
echo "  Player Service     → http://localhost:3001"
echo "  Score Service      → http://localhost:3002"
echo "  Leaderboard Service → http://localhost:3003"
echo "  Log Service        → http://localhost:3004"
echo ""
echo "Starting in 3 seconds… (Ctrl-C to abort)"
sleep 3

mkdir -p "$SCRIPT_DIR/results"

if [[ "${1:-}" == "--summary" ]]; then
  k6 run \
    --summary-export="$SUMMARY_FILE" \
    "$STRESS_SCRIPT"
  echo ""
  echo "Summary written to: $SUMMARY_FILE"
else
  k6 run "$STRESS_SCRIPT"
fi
