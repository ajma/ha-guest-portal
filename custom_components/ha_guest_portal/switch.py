"""Switch entity exposing the Guest Portal's enablement."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import GuestPortalConfigEntry
from .coordinator import GuestPortalCoordinator
from .entity import GuestPortalEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the Guest Portal switch."""
    async_add_entities([GuestPortalSwitch(entry.runtime_data)])


class GuestPortalSwitch(GuestPortalEntity, SwitchEntity):
    """Turns the guest surface on and off."""

    _attr_name = None

    def __init__(self, coordinator: GuestPortalCoordinator) -> None:
        """Set up the switch."""
        super().__init__(coordinator, "portal")
        self._optimistic: bool | None = None

    @property
    def is_on(self) -> bool:
        """Whether guests can currently reach the portal."""
        if self._optimistic is not None:
            return self._optimistic
        return self.coordinator.data.enabled

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Diagnostics a dashboard card can show alongside the toggle."""
        return {
            "device_count": self.coordinator.data.device_count,
            "ha_link_stale": self.coordinator.data.ha_stale,
        }

    async def _async_set(self, enabled: bool) -> None:
        # Show the new position immediately. Without this the toggle visibly
        # springs back until the next poll, up to the full scan interval.
        self._optimistic = enabled
        self.async_write_ha_state()

        try:
            await self.coordinator.api.async_set_enabled(enabled)
        finally:
            self._optimistic = None
            # Write state after clearing optimistic so the entity falls back to
            # the coordinator's truth immediately on failure, rather than showing
            # the wrong position until the next poll (up to 10s).
            self.async_write_ha_state()

        await self.coordinator.async_request_refresh()

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Let guests back in."""
        await self._async_set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Block guests."""
        await self._async_set(False)
