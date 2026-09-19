"""Shared entity base for the Guest Portal integration."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import GuestPortalCoordinator


class GuestPortalEntity(CoordinatorEntity[GuestPortalCoordinator]):
    """Base for entities backed by one portal.

    Both entities hang off a single device identified by the portal's own id,
    so they group on a dashboard and survive being re-added by a different
    route (manual setup versus Supervisor discovery).
    """

    _attr_has_entity_name = True

    def __init__(self, coordinator: GuestPortalCoordinator, key: str) -> None:
        """Attach to the coordinator and the shared device."""
        super().__init__(coordinator)

        portal_id = coordinator.data.portal_id

        self._attr_unique_id = f"{portal_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, portal_id)},
            name="Guest Portal",
            manufacturer="Home Assistant Guest Portal",
            sw_version=coordinator.data.version,
            configuration_url=coordinator.api.base_url,
        )
