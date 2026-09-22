"""One entity per portal on a platform, kept in step with the portal list.

Both platforms want exactly the same lifecycle -- add an entity when a portal
appears, take its entity and device away when it goes -- so they share it here
rather than keeping two copies that can drift apart.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import DOMAIN
from .coordinator import GuestPortalCoordinator
from .entity import GuestPortalEntity

if TYPE_CHECKING:
    from . import GuestPortalConfigEntry


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


def _registered_portal_ids(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    platform: str,
    key: str,
    deployment_id: str,
) -> set[str]:
    """The portal ids this platform already holds registry entries for."""
    prefix = f"{deployment_id}_"
    suffix = f"_{key}"
    return {
        entity.unique_id[len(prefix) : -len(suffix)]
        for entity in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)
        if entity.domain == platform
        and entity.unique_id.startswith(prefix)
        and entity.unique_id.endswith(suffix)
    }


def _remove_portals(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    platform: str,
    key: str,
    deployment_id: str,
    portal_ids: Iterable[str],
) -> None:
    """Take away the entity, and then the device, of each portal listed."""
    registry = er.async_get(hass)
    devices = dr.async_get(hass)
    for portal_id in portal_ids:
        device_key = f"{deployment_id}_{portal_id}"
        entity_id = registry.async_get_entity_id(platform, DOMAIN, f"{device_key}_{key}")
        if entity_id is not None:
            registry.async_remove(entity_id)
        _remove_device_if_empty(registry, devices, device_key, entry.entry_id)


@callback
def async_setup_portal_entities(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
    platform: str,
    key: str,
    build: Callable[[GuestPortalCoordinator, str], GuestPortalEntity],
) -> None:
    """Set up one entity per portal, and keep the set in sync as portals change."""
    coordinator = entry.runtime_data
    # Safe to read once: the coordinator refuses any poll whose deployment id
    # is not the one this entry was set up for.
    deployment_id = coordinator.data.deployment_id
    known_portal_ids: set[str] = set()

    @callback
    def _sync_entities() -> None:
        current_ids = {portal.portal_id for portal in coordinator.data.portals}

        new_ids = current_ids - known_portal_ids
        if new_ids:
            async_add_entities([build(coordinator, portal_id) for portal_id in new_ids])
            known_portal_ids.update(new_ids)

        removed_ids = known_portal_ids - current_ids
        if removed_ids:
            _remove_portals(hass, entry, platform, key, deployment_id, removed_ids)
            known_portal_ids.difference_update(removed_ids)

    # A portal deleted while this entry was not running is in no set the
    # listener below ever compares, so its entity and device would survive as
    # restored, permanently unavailable orphans. Reconcile against the registry
    # once, here, and let the listener handle everything after that.
    _remove_portals(
        hass,
        entry,
        platform,
        key,
        deployment_id,
        _registered_portal_ids(hass, entry, platform, key, deployment_id)
        - {portal.portal_id for portal in coordinator.data.portals},
    )

    _sync_entities()
    entry.async_on_unload(coordinator.async_add_listener(_sync_entities))
