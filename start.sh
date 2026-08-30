#!/usr/bin/env bash
# AI Auto Editor Pro — one-command start for macOS and Linux.
#
#   chmod +x start.sh && ./start.sh
#
# Everything the platform needs (PostgreSQL, Redis, FFmpeg, Node) runs inside
# Docker, so Docker Desktop is the only thing you install yourself.

set -euo pipefail
cd "$(dirname "$0")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'

say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$*"; }

say ""
say "  ${BOLD}AI Auto Editor Pro${RESET}"
say "  ${DIM}starting up…${RESET}"
say ""

# --- 1. Docker -------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker is not installed."
  say ""
  say "     Install Docker Desktop, then run this again:"
  say "     ${BOLD}https://www.docker.com/products/docker-desktop/${RESET}"
  say ""
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but not running."
  say ""
  say "     Start Docker Desktop, wait for it to finish loading, then run this again."
  say ""
  exit 1
fi
ok "Docker is running"

# `docker compose` (v2) is bundled with Docker Desktop; `docker-compose` is the
# older standalone binary some Linux installs still have.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  fail "Docker Compose was not found. Update Docker Desktop and try again."
  exit 1
fi

# --- 2. Configuration ------------------------------------------------------
if [ ! -f .env ]; then
  say "  ${DIM}Creating .env with freshly generated secrets…${RESET}"

  # openssl ships with macOS and virtually every Linux; fall back to /dev/urandom.
  if command -v openssl >/dev/null 2>&1; then
    JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
    ENCRYPTION_KEY="$(openssl rand -hex 32)"
  else
    JWT_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
    ENCRYPTION_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi

  python3 - "$JWT_SECRET" "$ENCRYPTION_KEY" <<'PY' 2>/dev/null || {
import re, sys
jwt, key = sys.argv[1], sys.argv[2]
text = open('.env.example').read()
text = re.sub(r'(?m)^JWT_SECRET=.*$', 'JWT_SECRET=' + jwt, text)
text = re.sub(r'(?m)^ENCRYPTION_KEY=.*$', 'ENCRYPTION_KEY=' + key, text)
open('.env', 'w').write(text)
PY
    # No python3: fall back to sed with a delimiter base64 cannot contain.
    sed -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
        -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${ENCRYPTION_KEY}|" \
        .env.example > .env
  }
  ok "Created .env"
else
  ok "Using your existing .env"
fi

# --- Ports -----------------------------------------------------------------
# .env is the source of truth; fall back to the compose defaults.
read_env() {
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env | tail -1 | tr -d '\r"'"'"''
}

WEB_PORT="$(read_env WEB_PORT)"; WEB_PORT="${WEB_PORT:-3000}"
API_PORT="$(read_env API_PORT)"; API_PORT="${API_PORT:-4000}"

WEB_URL="http://localhost:${WEB_PORT}"
API_URL="http://localhost:${API_PORT}"

# --- 3. Build and start ----------------------------------------------------
say ""
say "  ${DIM}Building and starting containers.${RESET}"
say "  ${DIM}The first run downloads and compiles everything — expect 5–10 minutes.${RESET}"
say "  ${DIM}Later runs take a few seconds.${RESET}"
say ""

"${COMPOSE[@]}" up -d --build

# --- 4. Wait until it actually answers -------------------------------------
say ""
printf '  Waiting for the platform to come up'
READY=0
for _ in $(seq 1 150); do
  if curl -fsS -m 2 "${API_URL}/ready" >/dev/null 2>&1 \
     && curl -fsS -m 2 -o /dev/null "${WEB_URL}" 2>/dev/null; then
    READY=1
    break
  fi
  printf '.'
  sleep 2
done
printf '\n\n'

if [ "$READY" -ne 1 ]; then
  warn "It did not answer within five minutes."
  say ""
  say "     See what went wrong with:"
  say "       ${BOLD}${COMPOSE[*]} logs --tail=80${RESET}"
  say ""
  exit 1
fi

ok "API   ${API_URL}"
ok "App   ${WEB_URL}"

# --- 5. Open a browser -----------------------------------------------------
if command -v open >/dev/null 2>&1; then open "${WEB_URL}" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "${WEB_URL}" >/dev/null 2>&1 || true
fi

say ""
say "  ${BOLD}Next steps${RESET}"
say "    1. Create an account — the first one becomes the administrator."
say "    2. Go to ${BOLD}API management${RESET} and add a Gemini API key."
say "       Get one free at https://aistudio.google.com/apikey"
say "    3. Create a project and upload a voiceover."
say ""
say "  ${DIM}Stop it with ./stop.sh — your data is kept.${RESET}"
say ""
