#!/usr/bin/env bash
# Set up dependencies and launch the T-Rex CLM demo server.
#
# Usage:
#   ./runme.sh
#
# The script:
#   1. Ensures Node.js is on PATH (best effort).
#   2. Installs npm dependencies if node_modules is missing.
#   3. Copies .env.example to .env if no .env exists (edit it for your CLM host/key).
#   4. Starts the server: node server.mjs (dotenv loads .env from this dir)

set -euo pipefail

# Locate a node binary if `node` isn't on PATH.
if ! command -v node >/dev/null 2>&1; then
  for cand in \
    /usr/local/lib/qwen-code/node/bin/node \
    /home/jtoberling/.unsloth/node/bin/node \
    /home/jtoberling/.antigravity-ide-server/bin/2.0.4-def9583aef9852ff94cb0dea16ede9bb6b095b30/node; do
    if [ -x "$cand" ]; then
      NODE_PATH="$cand"
      export PATH="$(dirname "$cand"):$PATH"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>= 20) not found on PATH. Install Node.js and re-run." >&2
  exit 1
fi

cd "$(dirname "$0")"

echo "Node: $(node --version)"

# Install deps if needed.
if [ ! -d node_modules ]; then
  echo "Installing npm dependencies..."
  npm install
fi

# Populate .env from the example if it doesn't exist yet.
if [ ! -f .env ]; then
  echo "Creating .env from .env.example. Review it before starting."
  cp .env.example .env
fi

# Start the server. The SSH tunnel to gx10 (ssh -L 8700:localhost:8700 user@gx10)
# must already be running; adjust CLM_BASE_URL in .env if it differs.
echo "Starting server at http://127.0.0.1:3000 (Ctrl+C to stop)..."
exec node server.mjs
