"""Update coordinator for the Guest Portal integration."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import DeploymentState, PortalApi, PortalAuthError, PortalConnectionError
from .const import DOMAIN, SCAN_INTERVAL

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

    async def _async_update_data(self) -> DeploymentState:
        """Fetch the portal's state, translating errors for Home Assistant."""
        try:
            return await self.api.async_get_state()
        except PortalAuthError as err:
            # Raises ConfigEntryAuthFailed so HA starts a reauth flow rather
            # than retrying a token the portal has already rejected.
            raise ConfigEntryAuthFailed(str(err)) from err
        except PortalConnectionError as err:
            raise UpdateFailed(str(err)) from err
