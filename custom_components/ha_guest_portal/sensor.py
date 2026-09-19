"""Sensor reporting the Guest Portal's most recent guest interaction."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import GuestPortalConfigEntry
from .coordinator import GuestPortalCoordinator
from .entity import GuestPortalEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the interaction sensor."""
    async_add_entities([GuestPortalLastInteraction(entry.runtime_data)])


class GuestPortalLastInteraction(GuestPortalEntity, SensorEntity):
    """When a guest last logged in or operated a device."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_translation_key = "last_interaction"

    def __init__(self, coordinator: GuestPortalCoordinator) -> None:
        """Set up the sensor."""
        super().__init__(coordinator, "last_interaction")

    @property
    def native_value(self) -> datetime | None:
        """The moment of the last guest interaction, or None if there has been none."""
        interaction = self.coordinator.data.last_interaction
        if interaction is None:
            return None

        # The portal reports milliseconds since the epoch.
        return dt_util.utc_from_timestamp(interaction.ts / 1000)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """What the interaction was.

        The shape is uniform across both kinds so an automation can branch on
        `kind` rather than probing for which attributes happen to exist. The
        device key is `target_entity_id`, not `entity_id`: Home Assistant reads
        a bare `entity_id` attribute as group membership.
        """
        interaction = self.coordinator.data.last_interaction
        if interaction is None:
            return {}

        return {
            "kind": interaction.kind,
            "target_entity_id": interaction.entity_id,
            "label": interaction.label,
            "action": interaction.action,
            "ok": interaction.ok,
        }
