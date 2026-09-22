"""The Home Assistant Guest Portal integration."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import PortalApi
from .const import CONF_TOKEN, DOMAIN
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

    entry.runtime_data = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: GuestPortalConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def async_remove_config_entry_device(
    hass: HomeAssistant, entry: GuestPortalConfigEntry, device: dr.DeviceEntry
) -> bool:
    """Offer a Delete button on any device that no longer stands for anything.

    Without this Home Assistant refuses device removal outright, so a user who
    meets an orphan has nothing to click and has to delete the whole
    integration to be rid of it.
    """
    deployment_id = entry.runtime_data.data.deployment_id
    live_keys = {deployment_id} | {
        f"{deployment_id}_{portal.portal_id}" for portal in entry.runtime_data.data.portals
    }

    return not any(
        identifier in live_keys for domain, identifier in device.identifiers if domain == DOMAIN
    )
