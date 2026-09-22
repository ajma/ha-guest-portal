"""Sensors reporting each portal's most recent guest interaction."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import GuestPortalConfigEntry
from .coordinator import GuestPortalCoordinator
from .entity import GuestPortalEntity
from .portal_entities import async_setup_portal_entities


async def async_setup_entry(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up one interaction sensor per portal, kept in sync as portals change."""
    async_setup_portal_entities(
        hass,
        entry,
        async_add_entities,
        Platform.SENSOR,
        "last_interaction",
        GuestPortalLastInteraction,
    )


class GuestPortalLastInteraction(GuestPortalEntity, SensorEntity):
    """When a guest of one portal last logged in or operated a device."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_translation_key = "last_interaction"

    def __init__(self, coordinator: GuestPortalCoordinator, portal_id: str) -> None:
        """Set up the sensor for one portal."""
        super().__init__(coordinator, portal_id, "last_interaction")

    @property
    def available(self) -> bool:
        """False once this portal has been deleted."""
        return super().available and self._current_portal() is not None

    @property
    def native_value(self) -> datetime | None:
        """The moment of this portal's last guest interaction, or None if there has been none."""
        portal = self._current_portal()
        if portal is None or portal.last_interaction is None:
            return None

        # The portal reports milliseconds since the epoch.
        return dt_util.utc_from_timestamp(portal.last_interaction.ts / 1000)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """What the interaction was.

        The shape is uniform across both kinds so an automation can branch on
        `kind` rather than probing for which attributes happen to exist. The
        device key is `target_entity_id`, not `entity_id`: Home Assistant reads
        a bare `entity_id` attribute as group membership.
        """
        portal = self._current_portal()
        interaction = portal.last_interaction if portal is not None else None
        if interaction is None:
            return {}

        return {
            "kind": interaction.kind,
            "target_entity_id": interaction.entity_id,
            "label": interaction.label,
            "action": interaction.action,
            "ok": interaction.ok,
        }
