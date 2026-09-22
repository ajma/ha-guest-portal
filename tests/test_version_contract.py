"""Pins the version contract between the integration and the portal server.

MIN_PORTAL_VERSION (here) and INTEGRATION_API_VERSION (in
src/server/http/routes-integration.ts) describe the same contract from
opposite ends, and nothing else asserts a relationship between them. Of the
two ways they can drift, only one is dangerous:

- server < MIN_PORTAL_VERSION: portal_version_too_old already catches this at
  runtime and raises a "please update the add-on" repair issue. Safe, and
  already covered by tests/test_api.py.
- MIN_PORTAL_VERSION > INTEGRATION_API_VERSION: the integration would refuse
  the very server shipped alongside it in this repo, for every fresh install,
  since the add-on can never report a version newer than its own current
  release. Nothing else catches that.
"""

import re
from pathlib import Path

from custom_components.ha_guest_portal.api import portal_version_too_old
from custom_components.ha_guest_portal.const import MIN_PORTAL_VERSION

ROUTES_FILE = Path(__file__).parent.parent / "src" / "server" / "http" / "routes-integration.ts"


def _read_integration_api_version() -> str:
    text = ROUTES_FILE.read_text()
    match = re.search(r"INTEGRATION_API_VERSION = '([^']+)'", text)
    assert match is not None, "could not find INTEGRATION_API_VERSION in the TS source"
    return match.group(1)


def test_min_portal_version_never_exceeds_what_the_server_reports():
    """The server this repo ships must always satisfy its own integration.

    If MIN_PORTAL_VERSION is ever bumped ahead of INTEGRATION_API_VERSION, the
    add-on and the integration released together would be mutually
    incompatible: portal_version_too_old would report the freshly-installed
    add-on as too old, with no version it could report to satisfy the
    integration until INTEGRATION_API_VERSION itself is bumped to match.
    """
    server_version = _read_integration_api_version()

    assert not portal_version_too_old(server_version), (
        f"MIN_PORTAL_VERSION ({MIN_PORTAL_VERSION}) exceeds INTEGRATION_API_VERSION "
        f"({server_version}); the server this repo ships would fail its own "
        "integration's version check"
    )
