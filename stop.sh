#!/usr/bin/env bash
# Stops AI Auto Editor Pro. Your projects, media and database are kept.
set -euo pipefail
cd "$(dirname "$0")"

if docker compose version >/dev/null 2>&1; then
  docker compose down
else
  docker-compose down
fi

printf '\n  Stopped. Your data is kept — ./start.sh brings it all back.\n'
printf '  To erase everything (projects, media, accounts): docker compose down -v\n\n'
