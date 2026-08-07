#!/usr/bin/env bash
# Generate a landing-page image via Pollinations.ai (free, no signup).
#
# Usage:
#   scripts/ai-os/generate-image.sh <output-path> "<prompt>" [width] [height] [seed]
#
# Example:
#   scripts/ai-os/generate-image.sh public/landing-assets/hero.jpg \
#     "BuilderHunt hero showing a developer profile card with activity score" 1600 1200
#
# Free tier limits (pollinations.ai): 1 image per request, no rate cap for
# low-volume use, model `flux` is the default. No API key required.
#
# Set POLLINATIONS_MODEL to override (default: flux).

set -euo pipefail

OUT="${1:?output path required}"
PROMPT="${2:?prompt required}"
WIDTH="${3:-1200}"
HEIGHT="${4:-900}"
SEED="${5:-builderhunt}"
MODEL="${POLLINATIONS_MODEL:-flux}"

mkdir -p "$(dirname "$OUT")"

# Pollinations URL convention: prompt in path, query params for size/seed/model.
# `nologo=true` removes the watermark. `enhance=true` runs an extra pass for
# composition quality (slower, ~+30s).
ENCODED_PROMPT=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$PROMPT")
URL="https://image.pollinations.ai/prompt/${ENCODED_PROMPT}?width=${WIDTH}&height=${HEIGHT}&model=${MODEL}&seed=${SEED}&nologo=true"

# -f fails on HTTP error. --max-time caps each attempt at 90s (Pollinations can
# queue during peak hours). -L follows redirects.
curl -fSL --max-time 90 -A "Mozilla/5.0" -o "$OUT" "$URL"

SIZE=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT")
echo "wrote $OUT ($SIZE bytes)"
