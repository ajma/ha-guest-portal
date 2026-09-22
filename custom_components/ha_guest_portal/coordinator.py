"""Update coordinator for the Guest Portal integration."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryError
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import (
    DeploymentState,
    PortalApi,
    PortalAuthError,
    PortalConnectionError,
    portal_version_too_old,
)
from .const import DOMAIN, MIN_PORTAL_VERSION, SCAN_INTERVAL

if TYPE_CHECKING:
    from . import GuestPortalConfigEntry

_LOGGER = logging.getLogger(__name__)


class GuestPortalCoordinator(DataUpdateCoordinator[DeploymentState]):
    """Polls the portal for its enablement and latest interaction."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: GuestPortalConfigEntry,
        api: PortalApi,
    ) -> None:
        """Set up the coordinator against a configured portal."""
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=SCAN_INTERVAL,
            config_entry=entry,
        )
        self.api = api
        self._too_old_issue_id = f"portal_too_old_{entry.entry_id}"

    async def _async_update_data(self) -> DeploymentState:
        """Fetch the portal's state, translating errors for Home Assistant."""
        try:
            state = await self.api.async_get_state()
        except PortalAuthError as err:
            # Raises ConfigEntryAuthFailed so HA starts a reauth flow rather
            # than retrying a token the portal has already rejected.
            raise ConfigEntryAuthFailed(str(err)) from err
        except PortalConnectionError as err:
            raise UpdateFailed(str(err)) from err

        if portal_version_too_old(state.version):
            self._async_report_too_old(state.version)
            # Failing rather than accepting the payload: an add-on this old
            # reports no portals, and taking that at face value would delete
            # every entity the user already has.
            raise UpdateFailed(
                f"The portal reports version {state.version}, but this integration"
                f" needs {MIN_PORTAL_VERSION} or newer"
            )

        ir.async_delete_issue(self.hass, DOMAIN, self._too_old_issue_id)

        unique_id = self.config_entry.unique_id
        if unique_id is not None and state.deployment_id != unique_id:
            # The add-on's database was replaced, so the deployment this entry
            # was configured against no longer exists. Adopting the new one's
            # portals would strand every existing entity under the old
            # deployment id and leave the newly discovered entry with nothing.
            raise ConfigEntryError(
                f"The add-on now reports deployment {state.deployment_id}, but this entry"
                f" was set up for {unique_id}. Delete this entry and set up the Guest"
                " Portal again."
            )

        return state

    @callback
    def _async_report_too_old(self, version: str) -> None:
        """Tell the user their add-on predates the contract this reads."""
        ir.async_create_issue(
            self.hass,
            DOMAIN,
            self._too_old_issue_id,
            is_fixable=False,
            severity=ir.IssueSeverity.ERROR,
            translation_key="portal_too_old",
            translation_placeholders={"found": version, "expected": MIN_PORTAL_VERSION},
        )
