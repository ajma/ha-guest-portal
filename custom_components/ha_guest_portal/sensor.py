"""Sensors reporting each portal's most recent guest interaction."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import GuestPortalConfigEntry
from .const import DOMAIN
from .coordinator import GuestPortalCoordinator
from .entity import GuestPortalEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up one interaction sensor per portal, kept in sync as portals change."""
    coordinator = entry.runtime_data
    known_portal_ids: set[str] = set()

    def _sync_entities() -> None:
        current_ids = {portal.portal_id for portal in coordinator.data.portals}

        new_ids = current_ids - known_portal_ids
        if new_ids:
            async_add_entities(
                [GuestPortalLastInteraction(coordinator, portal_id) for portal_id in new_ids]
            )
            known_portal_ids.update(new_ids)

        removed_ids = known_portal_ids - current_ids
        if removed_ids:
            registry = er.async_get(hass)
            for portal_id in removed_ids:
                unique_id = f"{coordinator.data.deployment_id}_{portal_id}_last_interaction"
                entity_id = registry.async_get_entity_id("sensor", DOMAIN, unique_id)
                if entity_id is not None:
                    registry.async_remove(entity_id)
            known_portal_ids.difference_update(removed_ids)

    _sync_entities()
    entry.async_on_unload(coordinator.async_add_listener(_sync_entities))


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
