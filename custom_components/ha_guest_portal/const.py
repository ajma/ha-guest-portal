"""Constants for the Home Assistant Guest Portal integration."""

from datetime import timedelta

DOMAIN = "ha_guest_portal"

DEFAULT_PORT = 8080
SCAN_INTERVAL = timedelta(seconds=10)

CONF_TOKEN = "token"

# The oldest /api/integration/state contract this integration can read. The
# portal reports its own version; anything below this raises a repair issue
# telling the user to update the add-on.
MIN_PORTAL_VERSION = "1.0.0"
