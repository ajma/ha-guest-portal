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
class PortalSummary:
    """One portal's state, as reported inside /api/integration/state's list."""

    portal_id: str
    title: str
    enabled: bool
    device_count: int
    last_interaction: Interaction | None


@dataclass(frozen=True)
class DeploymentState:
    """A snapshot of the whole deployment, as returned by /api/integration/state."""

    deployment_id: str
    ha_stale: bool
    version: str
    portals: list[PortalSummary]


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


def _parse_portal_summary(raw: Any) -> PortalSummary:
    return PortalSummary(
        portal_id=str(raw["portalId"]),
        title=str(raw["title"]),
        enabled=bool(raw["enabled"]),
        device_count=int(raw["deviceCount"]),
        last_interaction=_parse_interaction(raw["lastInteraction"]),
    )


def _parse_deployment_state(raw: Any) -> DeploymentState:
    # Missing or invalid version is treated as 0.0.0, which will fail the
    # minimum-version check and raise a repair issue rather than retrying forever.
    version = raw.get("version", "0.0.0")
    if not isinstance(version, str):
        version = "0.0.0"

    return DeploymentState(
        deployment_id=str(raw["deploymentId"]),
        ha_stale=bool(raw["haStale"]),
        version=version,
        portals=[_parse_portal_summary(p) for p in raw["portals"]],
    )


class PortalApi:
    """Talks to the bearer-authenticated routes the portal exposes."""

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

    async def async_get_state(self) -> DeploymentState:
        """Fetch every portal's current state."""
        raw = await self._request("GET", "/api/integration/state")

        try:
            return _parse_deployment_state(raw)
        except (KeyError, TypeError, ValueError) as err:
            # An add-on too old to speak this protocol looks exactly like this.
            raise PortalConnectionError(f"Unexpected response from the portal: {err}") from err

    async def async_set_enabled(self, portal_id: str, enabled: bool) -> None:
        """Enable or disable one portal."""
        await self._request(
            "POST", f"/api/integration/portals/{portal_id}/enabled", json={"enabled": enabled}
        )
