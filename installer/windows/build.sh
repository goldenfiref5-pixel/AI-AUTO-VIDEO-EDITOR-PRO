#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build the Windows installer.
#
#   installer/windows/build.sh [output.exe]
#
# Needs NSIS (apt install nsis). Produces a per-user installer that carries the
# application source; Docker Desktop is fetched at first launch if missing.
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
OUT="${1:-$ROOT/dist/AI-Auto-Editor-Pro-Setup.exe}"

command -v makensis >/dev/null 2>&1 || {
  echo "makensis not found. Install it with: sudo apt-get install -y nsis" >&2
  exit 1
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "Staging application files..."
# Tracked files only: no node_modules, no .git, no local .env.
git archive --format=tar HEAD | tar -x -C "$STAGE"

# The launcher lives at the install root so $PSScriptRoot resolves to it.
cp installer/windows/Setup.ps1 "$STAGE/Setup.ps1"

# Nothing Windows-side needs these, and they only add bulk.
rm -rf "$STAGE/installer" "$STAGE/.devcontainer" "$STAGE/.github"

FILES=$(find "$STAGE" -type f | wc -l)
BYTES=$(du -sh "$STAGE" | cut -f1)
echo "  ${FILES} files, ${BYTES}"

mkdir -p "$(dirname "$OUT")"

echo "Compiling installer..."
makensis -V2 \
  "-DSTAGEDIR=$STAGE" \
  "-DOUTFILE=$OUT" \
  installer/windows/installer.nsi

echo
echo "Built: $OUT"
ls -lh "$OUT" | awk '{print "  size: " $5}'
