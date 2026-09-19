"""The Home Assistant Guest Portal integration."""

from __future__ import annotations

from awesomeversion import AwesomeVersion
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import PortalApi
from .const import CONF_TOKEN, DOMAIN, MIN_PORTAL_VERSION
from .coordinator import GuestPortalCoordinator

PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.SWITCH]

type GuestPortalConfigEntry = ConfigEntry[GuestPortalCoordinator]


async def async_setup_entry(hass: HomeAssistant, entry: GuestPortalConfigEntry) -> bool:
    """Set up the Guest Portal from a config entry."""
    api = PortalApi(
        async_get_clientsession(hass),
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data[CONF_TOKEN],
    )

    coordinator = GuestPortalCoordinator(hass, entry, api)
    await coordinator.async_config_entry_first_refresh()

    # The portal reports the version of its integration API. An add-on too old
    # to speak this contract should say so plainly rather than surfacing as a
    # parse failure the user cannot act on.
    issue_id = f"portal_too_old_{entry.entry_id}"

    if AwesomeVersion(coordinator.data.version) < AwesomeVersion(MIN_PORTAL_VERSION):
        ir.async_create_issue(
            hass,
            DOMAIN,
            issue_id,
            is_fixable=False,
            severity=ir.IssueSeverity.ERROR,
            translation_key="portal_too_old",
            translation_placeholders={
                "found": coordinator.data.version,
                "expected": MIN_PORTAL_VERSION,
            },
        )
    else:
        ir.async_delete_issue(hass, DOMAIN, issue_id)

    entry.runtime_data = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: GuestPortalConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
