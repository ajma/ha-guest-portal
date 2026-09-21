"""Shared entity base for the Guest Portal integration."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .api import PortalSummary
from .const import DOMAIN
from .coordinator import GuestPortalCoordinator


class GuestPortalEntity(CoordinatorEntity[GuestPortalCoordinator]):
    """Base for entities backed by one specific portal.

    Both entities for a portal hang off one device identified by the
    combination of this deployment's id and that portal's own id, so portals
    group separately on a dashboard and each survives being re-added by a
    different route (manual setup versus Supervisor discovery), same as the
    single-portal version did for the deployment as a whole.
    """

    _attr_has_entity_name = True

    def __init__(self, coordinator: GuestPortalCoordinator, portal_id: str, key: str) -> None:
        """Attach to the coordinator, a specific portal, and the shared device."""
        super().__init__(coordinator)

        self._portal_id = portal_id
        deployment_id = coordinator.data.deployment_id
        device_key = f"{deployment_id}_{portal_id}"
        # Falls back to the old generic name only if the portal has already
        # vanished by construction time -- shouldn't happen in practice, since
        # callers only construct an entity for a portal id they just saw in
        # coordinator.data.portals, but device_info still needs some name.
        portal = self._current_portal()
        device_name = portal.title if portal is not None else "Guest Portal"

        self._attr_unique_id = f"{device_key}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, device_key)},
            name=device_name,
            manufacturer="Home Assistant Guest Portal",
            sw_version=coordinator.data.version,
            configuration_url=coordinator.api.base_url,
        )

    def _current_portal(self) -> PortalSummary | None:
        """This entity's own portal, or None if it was deleted since the last poll."""
        for portal in self.coordinator.data.portals:
            if portal.portal_id == self._portal_id:
                return portal
        return None
