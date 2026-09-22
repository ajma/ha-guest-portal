"""Switch entities exposing each portal's enablement."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchDeviceClass, SwitchEntity
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import GuestPortalConfigEntry
from .coordinator import GuestPortalCoordinator
from .entity import GuestPortalEntity
from .portal_entities import async_setup_portal_entities


async def async_setup_entry(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up one switch per portal, and keep the set in sync as portals change."""
    async_setup_portal_entities(
        hass, entry, async_add_entities, Platform.SWITCH, "portal", GuestPortalSwitch
    )


class GuestPortalSwitch(GuestPortalEntity, SwitchEntity):
    """Turns one portal's guest surface on and off."""

    _attr_device_class = SwitchDeviceClass.SWITCH
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

    @callback
    def _handle_coordinator_update(self) -> None:
        """Let a freshly polled value supersede whatever we guessed."""
        self._optimistic = None
        super()._handle_coordinator_update()

    async def _async_set(self, enabled: bool) -> None:
        self._optimistic = enabled
        self.async_write_ha_state()

        try:
            await self.coordinator.api.async_set_enabled(self._portal_id, enabled)
        except Exception:
            self._optimistic = None
            self.async_write_ha_state()
            raise

        # The guess stands until a poll replaces it: refreshes are debounced, so
        # dropping it here would snap a second toggle made inside the cooldown
        # back to the previous poll's value.
        await self.coordinator.async_request_refresh()

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Let guests back into this portal."""
        await self._async_set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Block guests from this portal."""
        await self._async_set(False)
