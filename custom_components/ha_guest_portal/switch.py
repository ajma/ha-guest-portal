"""Switch entities exposing each portal's enablement."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import GuestPortalConfigEntry
from .const import DOMAIN
from .coordinator import GuestPortalCoordinator
from .entity import GuestPortalEntity


def _remove_device_if_empty(
    registry: er.EntityRegistry,
    devices: dr.DeviceRegistry,
    device_key: str,
    config_entry_id: str,
) -> None:
    """Remove a deleted portal's device once its last entity is gone.

    A portal's switch and sensor share one device, and each platform only
    removes its own entity, so whichever of the two runs second is the one
    that finds the device empty. Without this the device outlives the portal
    as an empty entry in the device registry.
    """
    device = devices.async_get_device_by_identifier((DOMAIN, device_key), config_entry_id)
    if device is None:
        return
    if er.async_entries_for_device(registry, device.id, include_disabled_entities=True):
        return
    devices.async_remove_device(device.id)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up one switch per portal, and keep the set in sync as portals change."""
    coordinator = entry.runtime_data
    known_portal_ids: set[str] = set()

    def _sync_entities() -> None:
        current_ids = {portal.portal_id for portal in coordinator.data.portals}

        new_ids = current_ids - known_portal_ids
        if new_ids:
            async_add_entities([GuestPortalSwitch(coordinator, portal_id) for portal_id in new_ids])
            known_portal_ids.update(new_ids)

        removed_ids = known_portal_ids - current_ids
        if removed_ids:
            registry = er.async_get(hass)
            devices = dr.async_get(hass)
            for portal_id in removed_ids:
                device_key = f"{coordinator.data.deployment_id}_{portal_id}"
                entity_id = registry.async_get_entity_id("switch", DOMAIN, f"{device_key}_portal")
                if entity_id is not None:
                    registry.async_remove(entity_id)
                _remove_device_if_empty(registry, devices, device_key, entry.entry_id)
            known_portal_ids.difference_update(removed_ids)

    _sync_entities()
    entry.async_on_unload(coordinator.async_add_listener(_sync_entities))


class GuestPortalSwitch(GuestPortalEntity, SwitchEntity):
    """Turns one portal's guest surface on and off."""

    _attr_name = None

    def __init__(self, coordinator: GuestPortalCoordinator, portal_id: str) -> None:
        """Set up the switch for one portal."""
        super().__init__(coordinator, portal_id, "portal")
        self._optimistic: bool | None = None

    @property
    def available(self) -> bool:
        """False once this portal has been deleted."""
        return super().available and self._current_portal() is not None

    @property
    def is_on(self) -> bool:
        """Whether guests can currently reach this portal."""
        if self._optimistic is not None:
            return self._optimistic
        portal = self._current_portal()
        return portal.enabled if portal is not None else False

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Diagnostics a dashboard card can show alongside the toggle."""
        portal = self._current_portal()
        if portal is None:
            return {}
        return {
            "device_count": portal.device_count,
            "ha_link_stale": self.coordinator.data.ha_stale,
        }

    async def _async_set(self, enabled: bool) -> None:
        self._optimistic = enabled
        self.async_write_ha_state()

        try:
            await self.coordinator.api.async_set_enabled(self._portal_id, enabled)
        finally:
            self._optimistic = None
            self.async_write_ha_state()

        await self.coordinator.async_request_refresh()

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Let guests back into this portal."""
        await self._async_set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Block guests from this portal."""
        await self._async_set(False)
