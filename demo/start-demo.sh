#!/usr/bin/env sh
# Vault demo launcher for macOS / Linux. Usage: ./start-demo.sh [port]
cd "$(dirname "$0")" || exit 1
[ -f package.json ] || cd .. || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Run install-node.sh (next to this script) first, then run this again."; exit 1
fi
major=$(node -v | sed 's/^v//; s/\..*//')
if [ "$major" -lt 20 ]; then echo "Node.js 20 or newer is required (found $(node -v)). Run ./install-node.sh to upgrade."; exit 1; fi
if ! node demo/check-deps.cjs; then
  echo "The bundled dependencies were built for Windows / another Node version. Reinstalling for this machine (one time, needs internet)..."
  npm ci --no-audit --no-fund || { echo "npm ci failed."; exit 1; }
fi
if [ ! -f apps/web/.next/BUILD_ID ]; then
  echo "Building the web app (one time, a few minutes)..."
  npm run web:build || exit 1
fi
PORT="${1:-3000}"; export PORT
MTG_ROOT="$(pwd)"; export MTG_ROOT
echo "Starting Vault at http://localhost:$PORT   (Ctrl+C stops the demo)"
node demo/open-browser.mjs "$PORT" &
npm run web:start
