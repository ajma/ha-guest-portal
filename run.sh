#!/bin/sh
set -e

# Detect mode: if SUPERVISOR_TOKEN is set, we're running as a HA add-on
# (The Supervisor always sets it; plain Docker never does; the application
# cannot set its own environment - so it's a signal the app cannot influence)
if [ -n "$SUPERVISOR_TOKEN" ]; then
  # Add-on mode: read configuration from Supervisor
  if [ ! -f /data/options.json ]; then
    echo "Error: SUPERVISOR_TOKEN is set but /data/options.json is missing" >&2
    exit 1
  fi

  GUEST_PASSWORD=$(jq -r '.guest_password' /data/options.json)
  ADMIN_PASSWORD=$(jq -r '.admin_password' /data/options.json)
  PORT=$(jq -r '.port' /data/options.json)

  # Validate required passwords are present and not null
  if [ -z "$GUEST_PASSWORD" ] || [ "$GUEST_PASSWORD" = "null" ]; then
    echo "Error: guest_password is missing or null in /data/options.json" >&2
    exit 1
  fi
  if [ -z "$ADMIN_PASSWORD" ] || [ "$ADMIN_PASSWORD" = "null" ]; then
    echo "Error: admin_password is missing or null in /data/options.json" >&2
    exit 1
  fi

  export GUEST_PASSWORD
  export ADMIN_PASSWORD
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
  echo "Starting Home Assistant Guest Portal in Docker mode on port ${PORT:-8080}"
fi

# Start the server as PID 1 so it receives signals
cd /app
exec node dist/server/index.js
