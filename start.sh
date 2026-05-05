#!/bin/sh
# Load environment from .env.docker with automatic export
if [ -f /app/.env.docker ]; then
  while IFS='=' read -r key val; do
    case "$key" in
      ''|\#*) continue ;;
    esac
    export "$key=$val"
  done < /app/.env.docker
fi
exec node /app/server.prod.mjs
