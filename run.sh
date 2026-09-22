#!/bin/sh
set -e

# Overridable so a test can point this at a scratch directory instead of the
# real container path; unset in production, so behaviour there is unchanged.
APP_DIR="${APP_DIR:-/app}"

# Detect mode: if SUPERVISOR_TOKEN is set, we're running as a HA add-on
# (The Supervisor always sets it; plain Docker never does; the application
# cannot set its own environment - so it's a signal the app cannot influence)
if [ -n "$SUPERVISOR_TOKEN" ]; then
  # Add-on mode: read configuration from Supervisor
  # Overridable for the same reason as APP_DIR: lets a test point this at a
  # scratch options.json instead of the real Supervisor-managed path.
  OPTIONS_PATH="${OPTIONS_PATH:-/data/options.json}"
  if [ ! -f "$OPTIONS_PATH" ]; then
    echo "Error: SUPERVISOR_TOKEN is set but $OPTIONS_PATH is missing" >&2
    exit 1
  fi

  ADMIN_PASSWORD=$(jq -r '.admin_password' "$OPTIONS_PATH")
  # Port is fixed in add-on mode to match the container side of config.yaml's
  # ports mapping (9123/tcp: 9123). To change the host port, use the Supervisor's
  # Configuration → Network panel.
  PORT=9123

  # An unconfigured admin_password is valid - admin is then reachable only via
  # ingress. Export it only when actually set: config.ts parses ADMIN_PASSWORD
  # as optional with a minimum length, so an exported empty string would be
  # rejected where a genuinely absent variable is accepted.
  if [ -n "$ADMIN_PASSWORD" ] && [ "$ADMIN_PASSWORD" != "null" ]; then
    export ADMIN_PASSWORD
  fi
  export PORT

  # Set Home Assistant connection via Supervisor proxy
  export HA_BASE_URL="http://supervisor/core"
  export HA_WS_URL="ws://supervisor/core/websocket"
  export HA_TOKEN="$SUPERVISOR_TOKEN"

  # Set ingress port (admin access via HA sidebar)
  export INGRESS_PORT=8099

  # Set database path to add-on's persistent /data directory
  export DB_PATH="/data/portal.db"

  echo "Starting Home Assistant Guest Portal in add-on mode on port ${PORT}"
else
  # Plain Docker mode: environment is already configured
  echo "Starting Home Assistant Guest Portal in Docker mode on port ${PORT:-9123}"
fi

# Start the server as PID 1 so it receives signals
cd "$APP_DIR"
exec node dist/server/index.js
