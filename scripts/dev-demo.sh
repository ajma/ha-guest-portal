#!/usr/bin/env bash
# Interactive hot-reload development stack.
#
#   fake Home Assistant  :8124   seeded, stands in for a real HA instance
#   portal server        :9123   node --watch, restarts on any src/server change
#   Vite dev server      :5173   HMR for the React SPA, proxies /api to :9123
#
# Open http://localhost:5173 — that is the one with hot reload. Port 9123 also
# serves the SPA, but from the last `pnpm build`, so it will look stale.
#
# NOTE ON EXPOSURE: the portal server calls listen(port) with no host, so it
# binds every interface — including LAN and, on this machine, tailscale0. Vite
# binds localhost only. The passwords below are throwaway dev values; do not
# reuse them anywhere real.

set -euo pipefail

cd "$(dirname "$0")/.."

FAKE_HA_PORT="${FAKE_HA_PORT:-8124}"
FAKE_HA_TOKEN="${FAKE_HA_TOKEN:-dev-fake-ha-token}"
PORT="${PORT:-9123}"

export FAKE_HA_PORT FAKE_HA_TOKEN PORT

mkdir -p .dev-data

pids=()
cleanup() {
  echo ""
  echo "[dev] shutting down..."
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "[dev] stopped"
}
trap cleanup EXIT INT TERM

echo "[dev] starting fake Home Assistant on :${FAKE_HA_PORT}"
node --experimental-strip-types scripts/dev-fake-ha.ts &
pids+=($!)

# Give the fake HA a moment to bind before the portal tries to connect. The
# portal tolerates an absent HA (it starts stale and reconnects), so this is
# about keeping the startup log readable rather than correctness.
sleep 1

# The server cannot be run straight from TypeScript: files under src/ import
# each other with .js specifiers (correct for the compiled output), and Node's
# --experimental-strip-types does not remap those back to .ts. So compile in
# watch mode and run the emitted JavaScript.
echo "[dev] starting tsc --watch (src/server -> dist/server)"
./node_modules/.bin/tsc -p tsconfig.server.json --watch --preserveWatchOutput &
pids+=($!)

echo -n "[dev] waiting for first compile"
for _ in $(seq 1 60); do
  [ -f dist/server/index.js ] && break
  echo -n "."
  sleep 1
done
echo ""
if [ ! -f dist/server/index.js ]; then
  echo "[dev] tsc did not emit dist/server/index.js — aborting" >&2
  exit 1
fi

echo "[dev] starting portal server on :${PORT} (node --watch)"
HA_BASE_URL="http://127.0.0.1:${FAKE_HA_PORT}" \
HA_TOKEN="${FAKE_HA_TOKEN}" \
GUEST_PASSWORD="dev-guest-password" \
ADMIN_PASSWORD="dev-admin-password" \
PORT="${PORT}" \
DB_PATH="./.dev-data/portal.db" \
  node --watch dist/server/index.js &
pids+=($!)

echo "[dev] starting Vite on :5173 (HMR, /api -> :${PORT})"
./node_modules/.bin/vite --port 5173 &
pids+=($!)

cat <<EOF

  ───────────────────────────────────────────────
   Guest / admin UI   http://localhost:5173
   Guest password     dev-guest-password
   Admin password     dev-admin-password
   Admin screen       http://localhost:5173/admin
   Fake HA            http://127.0.0.1:${FAKE_HA_PORT}
  ───────────────────────────────────────────────
   Ctrl-C to stop everything.

EOF

wait
