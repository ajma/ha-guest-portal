"""HTTP client for the Guest Portal add-on's integration API."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import aiohttp
from aiohttp import ClientSession

TIMEOUT = aiohttp.ClientTimeout(total=10)


class PortalError(Exception):
    """Base error for the Guest Portal client."""


class PortalConnectionError(PortalError):
    """The portal could not be reached, or answered with something unusable."""


class PortalAuthError(PortalError):
    """The portal rejected the integration token."""


@dataclass(frozen=True)
class Interaction:
    """The most recent guest interaction reported by the portal."""

    ts: int
    kind: str
    entity_id: str | None
    label: str | None
    action: str | None
    ok: bool


@dataclass(frozen=True)
class PortalState:
    """A snapshot of the portal, as returned by /api/integration/state."""

    portal_id: str
    enabled: bool
    ha_stale: bool
    device_count: int
    version: str
    last_interaction: Interaction | None


def _parse_interaction(raw: Any) -> Interaction | None:
    if raw is None:
        return None

    return Interaction(
        ts=int(raw["ts"]),
        kind=str(raw["kind"]),
        entity_id=raw["entityId"],
        label=raw["label"],
        action=raw["action"],
        ok=bool(raw["ok"]),
    )


def _parse_state(raw: Any) -> PortalState:
    # Missing or invalid version is treated as 0.0.0, which will fail the
    # minimum-version check and raise a repair issue rather than retrying forever.
    version = raw.get("version", "0.0.0")
    if not isinstance(version, str):
        version = "0.0.0"

    return PortalState(
        portal_id=str(raw["portalId"]),
        enabled=bool(raw["enabled"]),
        ha_stale=bool(raw["haStale"]),
        device_count=int(raw["deviceCount"]),
        version=version,
        last_interaction=_parse_interaction(raw["lastInteraction"]),
    )


class PortalApi:
    """Talks to the two bearer-authenticated routes the portal exposes."""

    def __init__(self, session: ClientSession, host: str, port: int, token: str) -> None:
        """Store the connection details. No I/O happens here."""
        self._session = session
        self._base_url = f"http://{host}:{port}"
        self._token = token

    @property
    def base_url(self) -> str:
        """The portal's base URL, for logging and diagnostics."""
        return self._base_url

    async def _request(self, method: str, path: str, json: Any = None) -> Any:
        try:
            async with self._session.request(
                method,
                f"{self._base_url}{path}",
                json=json,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=TIMEOUT,
            ) as response:
                if response.status == 401:
                    raise PortalAuthError("The portal rejected the integration token")

                if response.status >= 400:
                    raise PortalConnectionError(f"The portal returned HTTP {response.status}")

                return await response.json()
        except PortalError:
            raise
        except (TimeoutError, aiohttp.ClientError, ValueError) as err:
            raise PortalConnectionError(f"Could not reach the portal: {err}") from err

    async def async_get_state(self) -> PortalState:
        """Fetch the portal's current state."""
        raw = await self._request("GET", "/api/integration/state")

        try:
            return _parse_state(raw)
        except (KeyError, TypeError, ValueError) as err:
            # An add-on too old to speak this protocol looks exactly like this.
            raise PortalConnectionError(f"Unexpected response from the portal: {err}") from err

    async def async_set_enabled(self, enabled: bool) -> None:
        """Enable or disable the guest portal."""
        await self._request("POST", "/api/integration/enabled", json={"enabled": enabled})
