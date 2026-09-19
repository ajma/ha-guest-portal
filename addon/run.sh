#!/bin/sh
set -e

# Read add-on options from /data/options.json
export GUEST_PASSWORD=$(jq -r '.guest_password' /data/options.json)
export ADMIN_PASSWORD=$(jq -r '.admin_password' /data/options.json)
export PORT=$(jq -r '.port' /data/options.json)

# Set Home Assistant connection via Supervisor proxy
export HA_BASE_URL="http://supervisor/core"
export HA_WS_URL="ws://supervisor/core/websocket"
export HA_TOKEN="$SUPERVISOR_TOKEN"

# Set database path to add-on's persistent /data directory
export DB_PATH="/data/portal.db"

# Log configuration (without sensitive values)
echo "Starting Home Assistant Guest Portal on port ${PORT}"

# Start the server as PID 1 so it receives signals
cd /app
exec node dist/server/index.js
