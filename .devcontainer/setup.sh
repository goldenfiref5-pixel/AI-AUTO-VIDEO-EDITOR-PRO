#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Prepare a Codespace (or any dev container) to run the platform.
#
# The only thing that genuinely differs from a laptop is the URLs: a Codespace
# serves the app from https://<codespace>-3000.app.github.dev, not localhost, so
# the browser-facing values in .env have to point there or sign-in and uploads
# fail on CORS.
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }

WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-4000}"

# --- Work out the URLs the browser will actually use -----------------------
if [ -n "${CODESPACE_NAME:-}" ]; then
  DOMAIN="${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  WEB_URL="https://${CODESPACE_NAME}-${WEB_PORT}.${DOMAIN}"
  API_URL="https://${CODESPACE_NAME}-${API_PORT}.${DOMAIN}"
  ok "Codespace detected: ${CODESPACE_NAME}"
else
  WEB_URL="http://localhost:${WEB_PORT}"
  API_URL="http://localhost:${API_PORT}"
  ok "Local dev container"
fi

# --- Create .env if missing, with real secrets -----------------------------
if [ ! -f .env ]; then
  if command -v openssl >/dev/null 2>&1; then
    JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
    ENCRYPTION_KEY="$(openssl rand -hex 32)"
  else
    JWT_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
    ENCRYPTION_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi

  sed -e "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|" \
      -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${ENCRYPTION_KEY}|" \
      .env.example > .env
  ok "Created .env with generated secrets"
else
  ok "Using the existing .env"
fi

# --- Point the browser-facing URLs at this environment ---------------------
# These four must agree or the app loads but every request is refused.
set_env() {
  local key="$1" value="$2"
  if grep -qE "^[[:space:]]*${key}=" .env; then
    sed -i "s|^[[:space:]]*${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

set_env API_PUBLIC_URL       "$API_URL"
set_env WEB_PUBLIC_URL       "$WEB_URL"
set_env CORS_ORIGINS         "$WEB_URL"
set_env NEXT_PUBLIC_API_URL  "$API_URL"

ok "Pointed .env at ${WEB_URL}"

printf '\n  %sReady.%s Start the platform with:\n\n' "$BOLD" "$RESET"
printf '    %sdocker compose up --build%s\n\n' "$BOLD" "$RESET"
printf '  %sFirst run compiles everything — expect 5–10 minutes.%s\n' "$DIM" "$RESET"

if [ -n "${CODESPACE_NAME:-}" ]; then
  printf '\n  Then open the %sPorts%s tab and click the globe next to port %s.\n' "$BOLD" "$RESET" "$WEB_PORT"
  warn "Port ${API_PORT} must be set to Public in the Ports tab."
  printf '     %sThe browser calls the API directly, so a private port gets an%s\n' "$DIM" "$RESET"
  printf '     %sauth redirect instead of JSON. Right-click the port →%s\n' "$DIM" "$RESET"
  printf '     %sPort Visibility → Public.%s\n' "$DIM" "$RESET"
fi
printf '\n'
