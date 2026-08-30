#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Works out why the app is not reachable and prints the exact command to fix it.
#
#   ./doctor.sh
# ---------------------------------------------------------------------------
cd "$(dirname "$0")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }

VERDICT=""
FIX=""

printf '\n  %sAI Auto Editor Pro — diagnostics%s\n\n' "$BOLD" "$RESET"

# --- 1. Which compose command exists ---------------------------------------
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  bad "Docker Compose was not found."
  printf '\n  %sInstall Docker Desktop, then run this again.%s\n\n' "$BOLD" "$RESET"
  exit 1
fi
ok "Docker Compose available"

if ! docker info >/dev/null 2>&1; then
  bad "Docker is installed but not running."
  printf '\n  %sStart Docker Desktop, wait for the whale icon to settle, then retry.%s\n\n' "$BOLD" "$RESET"
  exit 1
fi
ok "Docker daemon running"

# --- 2. Is the checkout current? -------------------------------------------
# Before the port commit, docker-compose.yml hard-coded 3000:3000, so setting
# WEB_PORT in .env had no effect at all.
if grep -q 'WEB_PORT' docker-compose.yml 2>/dev/null; then
  ok "docker-compose.yml supports custom ports"
else
  bad "docker-compose.yml has the ports hard-coded — this checkout is out of date."
  VERDICT="Your code predates configurable ports, so WEB_PORT is ignored."
  FIX="git pull && ${COMPOSE[*]} down && ${COMPOSE[*]} up -d --build"
fi

# --- 3. What do the settings say? ------------------------------------------
read_env() {
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env | tail -1 | tr -d '\r"'"'"''
}

if [ ! -f .env ]; then
  bad ".env does not exist — compose is using the built-in defaults (3000/4000)."
  [ -z "$VERDICT" ] && {
    VERDICT="There is no .env, so your WEB_PORT setting is not being read."
    FIX="./start.sh   ${DIM}# creates .env, then edit it and re-run${RESET}"
  }
else
  WEB_PORT="$(read_env WEB_PORT)"; WEB_PORT="${WEB_PORT:-3000}"
  API_PORT="$(read_env API_PORT)"; API_PORT="${API_PORT:-4000}"
  ok ".env says WEB_PORT=${WEB_PORT}  API_PORT=${API_PORT}"

  CORS="$(read_env CORS_ORIGINS)"
  NEXT_API="$(read_env NEXT_PUBLIC_API_URL)"
  [ "$CORS" = "http://localhost:${WEB_PORT}" ] \
    || warn "CORS_ORIGINS is '${CORS}' but the web app is on ${WEB_PORT} — sign-in will fail."
  [ "$NEXT_API" = "http://localhost:${API_PORT}" ] \
    || warn "NEXT_PUBLIC_API_URL is '${NEXT_API}' but the API is on ${API_PORT} — rebuild the web image."
fi

WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-4000}"

# --- 4. What is actually running? ------------------------------------------
printf '\n  %sContainers%s\n' "$BOLD" "$RESET"
PS_OUT="$("${COMPOSE[@]}" ps 2>/dev/null)"
if [ -z "$(printf '%s' "$PS_OUT" | sed -n '2,$p')" ]; then
  bad "Nothing is running."
  [ -z "$VERDICT" ] && {
    VERDICT="The stack was never started, or it was stopped."
    FIX="${COMPOSE[*]} up -d --build"
  }
else
  printf '%s\n' "$PS_OUT" | sed 's/^/    /'
fi

# --- 5. What is the published mapping, really? -----------------------------
MAPPED="$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Ports}}' 2>/dev/null | grep -E '^web ' || true)"
if [ -n "$MAPPED" ]; then
  if printf '%s' "$MAPPED" | grep -q ":${WEB_PORT}->"; then
    ok "web is published on ${WEB_PORT}"
  else
    bad "web is NOT published on ${WEB_PORT} — it is: ${MAPPED#web }"
    [ -z "$VERDICT" ] && {
      VERDICT="The running container still has its old port mapping."
      FIX="${COMPOSE[*]} down && ${COMPOSE[*]} up -d --build"
    }
  fi
fi

# --- 6. Does it answer? -----------------------------------------------------
printf '\n  %sReachability%s\n' "$BOLD" "$RESET"
probe() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 3 -o /dev/null "$1" 2>/dev/null
  else
    return 2
  fi
}

for p in "$WEB_PORT" 3000; do
  if probe "http://localhost:${p}"; then
    ok "http://localhost:${p} answers"
    [ "$p" != "$WEB_PORT" ] && {
      VERDICT="The app is running, but on ${p} — not the ${WEB_PORT} you configured."
      FIX="${COMPOSE[*]} down && ${COMPOSE[*]} up -d --build"
    }
    break
  else
    bad "http://localhost:${p} refused"
  fi
done

# --- 7. Verdict -------------------------------------------------------------
printf '\n  %sVerdict%s\n' "$BOLD" "$RESET"
if [ -n "$VERDICT" ]; then
  printf '    %s\n\n' "$VERDICT"
  printf '  %sRun this:%s\n\n    %s%s%s\n\n' "$BOLD" "$RESET" "$BOLD" "$FIX" "$RESET"
else
  printf '    Everything checks out. Open %shttp://localhost:%s%s\n\n' "$BOLD" "$WEB_PORT" "$RESET"
  printf '  %sIf the browser still refuses, check logs:%s\n    %s logs web --tail=40\n\n' \
    "$DIM" "$RESET" "${COMPOSE[*]}"
fi
