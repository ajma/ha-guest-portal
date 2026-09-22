"""HTTP client for the Guest Portal add-on's integration API."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import aiohttp
from aiohttp import ClientSession
from awesomeversion import AwesomeVersion, AwesomeVersionCompareException

from .const import MIN_PORTAL_VERSION

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


def portal_version_too_old(version: str) -> bool:
    """Whether a reported add-on version predates the contract we can read.

    The `except` below is unreachable as the code stands. Every caller passes a
    `DeploymentState.version`, and `_parse_version` has already rejected
    anything `AwesomeVersion` cannot parse: an absent key becomes "0.0.0", and
    a present-but-unusable one is raised as a malformed payload there instead.

    It is kept because this function is public and takes a bare string, so a
    caller that has not been through `_parse_version` should get the "update
    the add-on" repair issue rather than a traceback. Anyone adding such a
    caller is making this branch live rather than writing a new one.
    """
    try:
        return AwesomeVersion(version) < AwesomeVersion(MIN_PORTAL_VERSION)
    except AwesomeVersionCompareException:
        return True


def _parse_version(raw: dict[str, Any]) -> str:
    """Read the add-on's reported version, as a version we can compare.

    The route has sent `version` since its first commit, so an absent key is
    not a real add-on's payload; the "0.0.0" fallback is a defensive default,
    not a compatibility shim for a release that predates the field. It still
    resolves to the "update the add-on" repair issue rather than a traceback,
    which is the right outcome if this branch ever does run. A version that is
    present but unusable is a different fault: it comes from something
    claiming to be current, so telling that user to update sends them after an
    upgrade that does not exist. That is reported as a malformed payload
    instead.
    """
    if "version" not in raw:
        return "0.0.0"

    version = raw["version"]

    if not isinstance(version, str):
        raise TypeError(f"version must be a string, got {type(version).__name__}")

    if not AwesomeVersion(version).valid:
        raise ValueError(f"version {version!r} is not a version number")

    return version


def _parse_deployment_state(raw: Any) -> DeploymentState:
    if not isinstance(raw, dict):
        raise TypeError(f"expected an object, got {type(raw).__name__}")

    version = _parse_version(raw)

    if portal_version_too_old(version):
        # An add-on this old has neither a portal list nor a deployment id in
        # its payload, so insisting on them would turn "your add-on is out of
        # date" into an unactionable parse error. Reading it as an empty
        # deployment lets the caller raise the repair issue instead. haStale is
        # still required: it is the oldest field this integration has ever
        # read, so a payload without it is not a portal's at all.
        return DeploymentState(
            deployment_id=str(raw.get("deploymentId", "")),
            ha_stale=bool(raw["haStale"]),
            version=version,
            portals=[],
        )

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
            raise PortalConnectionError(f"Unexpected response from the portal: {err}") from err

    async def async_set_enabled(self, portal_id: str, enabled: bool) -> None:
        """Enable or disable one portal."""
        await self._request(
            "POST", f"/api/integration/portals/{portal_id}/enabled", json={"enabled": enabled}
        )
