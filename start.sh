#!/bin/sh
# Load .env.docker if it exists (for self-contained deployment)
if [ -f /app/.env.docker ]; then
  set -a
  . /app/.env.docker
  set +a
fi
exec node /app/server.prod.mjs
