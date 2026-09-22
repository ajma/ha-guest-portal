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
# binds localhost only. The admin password below is a throwaway dev value; do
# not reuse it anywhere real.
#
# There is no guest password to set here: portals are created at runtime
# through the admin UI, and each one carries its own.

#
# HA_MODE=fake (default) spins up the seeded stand-in above.
# HA_MODE=real reads HA_BASE_URL / HA_TOKEN / ADMIN_PASSWORD from .env and talks
# to your actual Home Assistant. DB_PATH from .env is ignored in real mode —
# it points at the container path /data, which does not exist here.

set -euo pipefail

cd "$(dirname "$0")/.."

HA_MODE="${HA_MODE:-fake}"
FAKE_HA_PORT="${FAKE_HA_PORT:-8124}"
FAKE_HA_TOKEN="${FAKE_HA_TOKEN:-dev-fake-ha-token}"

mkdir -p .dev-data
DEV_DB="./.dev-data/portal.db"

if [ "$HA_MODE" = "real" ]; then
  if [ ! -f .env ]; then
    echo "[dev] HA_MODE=real needs a .env with HA_BASE_URL, HA_TOKEN, ADMIN_PASSWORD" >&2
    exit 1
  fi
  # Split across lines, not `set -a; . ./.env; set +a`, so the directive below
  # binds to the `.` command rather than to `set -a`. Behaviour is identical.
  set -a
  # .env is gitignored and absent at lint time; silences SC1091 here only.
  # shellcheck source=/dev/null
  . ./.env
  set +a
  : "${HA_BASE_URL:?missing in .env}"
  : "${HA_TOKEN:?missing in .env}"
  : "${ADMIN_PASSWORD:?missing in .env}"
  # .env's DB_PATH is the in-container path; use a local one instead.
  DB_PATH="$DEV_DB"
else
  HA_BASE_URL="http://127.0.0.1:${FAKE_HA_PORT}"
  HA_TOKEN="$FAKE_HA_TOKEN"
  ADMIN_PASSWORD="dev-admin-password"
  DB_PATH="$DEV_DB"
fi

PORT="${PORT:-9123}"
export FAKE_HA_PORT FAKE_HA_TOKEN PORT

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

if [ "$HA_MODE" = "real" ]; then
  echo "[dev] HA_MODE=real — using Home Assistant at ${HA_BASE_URL}"
  echo "[dev] REAL DEVICES: anything you add to the allowlist becomes actuable"
  echo "[dev]               by anyone who can reach :${PORT} with a portal password."
else
  echo "[dev] starting fake Home Assistant on :${FAKE_HA_PORT}"
  node --experimental-strip-types scripts/dev-fake-ha.ts &
  pids+=($!)

  # Give the fake HA a moment to bind before the portal tries to connect. The
  # portal tolerates an absent HA (it starts stale and reconnects), so this is
  # about keeping the startup log readable rather than correctness.
  sleep 1
fi

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
HA_BASE_URL="$HA_BASE_URL" \
HA_TOKEN="$HA_TOKEN" \
ADMIN_PASSWORD="$ADMIN_PASSWORD" \
PORT="${PORT}" \
DB_PATH="$DB_PATH" \
  node --watch dist/server/index.js &
pids+=($!)

echo "[dev] starting Vite on :5173 (HMR, /api -> :${PORT})"
./node_modules/.bin/vite --port 5173 &
pids+=($!)

if [ "$HA_MODE" = "real" ]; then
  cat <<EOF

  ───────────────────────────────────────────────
   Guest / admin UI   http://localhost:5173
   Admin password     from .env (ADMIN_PASSWORD)
   Guest passwords    per portal, created through the admin UI
   Home Assistant     ${HA_BASE_URL}  (REAL)
   Portal DB          ${DB_PATH}
  ───────────────────────────────────────────────
   Ctrl-C to stop everything.

EOF
else
  cat <<EOF

  ───────────────────────────────────────────────
   Guest / admin UI   http://localhost:5173
   Admin password     dev-admin-password
   Guest passwords    per portal, created through the admin UI
   Fake HA            http://127.0.0.1:${FAKE_HA_PORT}
  ───────────────────────────────────────────────
   Ctrl-C to stop everything.

EOF
fi

wait
