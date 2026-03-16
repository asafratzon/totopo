#!/bin/bash
# =============================================================================
# ai.sh — totopo entry point
# Run this from your project directory (or via npx totopo).
# =============================================================================

set -euo pipefail

# ─── Guard: inside container ─────────────────────────────────────────────────
if [ "$(whoami)" = "devuser" ]; then
  echo ""
  echo "  You are running totopo from inside the dev container."
  echo "  Open a terminal on your host machine and run:"
  echo ""
  echo "    totopo  (or ./path/to/ai.sh from your project directory)"
  echo ""
  exit 1
fi

# ─── Paths ───────────────────────────────────────────────────────────────────
# Resolve symlinks so PACKAGE_DIR points to the real package root, not .bin/
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
PACKAGE_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"

if [ -z "$REPO_ROOT" ]; then
  echo ""
  echo "  No git repository found."
  echo ""
  echo "  totopo requires a git repository. Run 'git init' first, then re-run totopo."
  echo ""
  exit 1
fi

export TOTOPO_PACKAGE_DIR="$PACKAGE_DIR"
export TOTOPO_REPO_ROOT="$REPO_ROOT"

# ─── Node.js check ──────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo ""
  echo "  Node.js is required to run totopo."
  echo "  Install it from https://nodejs.org/ (v18+)"
  echo ""
  exit 1
fi

# ─── Auto-install dependencies ───────────────────────────────────────────────
# Check for tsx binary directly — node_modules/ may exist but be incomplete
# (e.g. pnpm store cleaned, or npx cache partially populated)
TSX="$PACKAGE_DIR/node_modules/.bin/tsx"
if [ ! -f "$TSX" ]; then
  echo "  Installing totopo dependencies..."
  if command -v pnpm &>/dev/null; then
    (cd "$PACKAGE_DIR" && pnpm install --silent 2>/dev/null)
  else
    (cd "$PACKAGE_DIR" && npm install --silent 2>/dev/null)
  fi
fi

# ─── Onboarding ──────────────────────────────────────────────────────────────
if [ ! -f "$REPO_ROOT/.totopo/devcontainer.json" ]; then
  "$TSX" "$PACKAGE_DIR/src/core/onboard.ts"
  if [ ! -f "$REPO_ROOT/.totopo/devcontainer.json" ]; then
    exit 0
  fi
fi

# ─── Doctor (silent pre-check) ───────────────────────────────────────────────
if ! "$TSX" "$PACKAGE_DIR/src/core/doctor.ts"; then
  echo "  Fix the issues above and re-run totopo."
  echo ""
  exit 1
fi

# ─── Gather state for menu ──────────────────────────────────────────────────
PROJECT_NAME="$(basename "$REPO_ROOT")"
WORKSPACE_NAME="totopo-managed-$PROJECT_NAME"

ACTIVE_COUNT=$(docker ps --filter "name=totopo-managed-" --format "{{.Names}}" 2>/dev/null | wc -l | tr -d '[:space:]')

HAS_KEY=false
if [ -f "$REPO_ROOT/.totopo/.env" ]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    value="$(echo "$value" | tr -d '[:space:]')"
    if [ -n "$value" ]; then HAS_KEY=true; break; fi
  done < "$REPO_ROOT/.totopo/.env"
fi

# ─── Interactive menu (clack) ────────────────────────────────────────────────
# stdout → /dev/tty (clack UI displayed on terminal)
# stderr → captured (selected action string)
set +e
action=$("$TSX" "$PACKAGE_DIR/src/core/menu.ts" "$PROJECT_NAME" "$ACTIVE_COUNT" "$HAS_KEY" 2>&1 >/dev/tty)
set -e

# ─── Execute selection ───────────────────────────────────────────────────────
case "$action" in
  dev)     "$TSX" "$PACKAGE_DIR/src/core/dev.ts" ;;
  stop)    "$TSX" "$PACKAGE_DIR/src/core/stop.ts" ;;
  reset)   "$TSX" "$PACKAGE_DIR/src/core/reset.ts" ;;
  doctor)  "$TSX" "$PACKAGE_DIR/src/core/doctor.ts" --verbose ;;
  quit|*)  exit 0 ;;
esac
