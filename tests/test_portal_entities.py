"""Tests for the per-portal entity lifecycle shared by both platforms."""

from dataclasses import replace
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_guest_portal.api import (
    DeploymentState,
    PortalConnectionError,
    PortalSummary,
)
from custom_components.ha_guest_portal.const import CONF_TOKEN, DOMAIN
from custom_components.ha_guest_portal.portal_entities import _remove_device_if_empty

DEPLOYMENT_ID = "dep-1"

STATE = DeploymentState(
    deployment_id=DEPLOYMENT_ID,
    ha_stale=False,
    version="2.0.0",
    portals=[
        PortalSummary(
            portal_id="timothy",
            title="Timothy",
            enabled=True,
            device_count=3,
            last_interaction=None,
        ),
    ],
)


STATE_NO_PORTALS = replace(STATE, portals=[])

SWITCH_UNIQUE_ID = f"{DEPLOYMENT_ID}_timothy_portal"


@pytest.fixture
def entry(hass: HomeAssistant) -> MockConfigEntry:
    """A config entry for a deployment reporting one portal, not yet set up."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=DEPLOYMENT_ID,
        data={"host": "127.0.0.1", "port": 8080, CONF_TOKEN: "good-token"},
        title="Guest Portal",
    )
    entry.add_to_hass(hass)
    return entry


def _register_portal(hass: HomeAssistant, entry: MockConfigEntry, portal_id: str) -> None:
    """Leave behind what a previous run of this entry would have registered."""
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, f"{DEPLOYMENT_ID}_{portal_id}")},
        name=portal_id,
    )
    registry = er.async_get(hass)
    registry.async_get_or_create(
        "switch",
        DOMAIN,
        f"{DEPLOYMENT_ID}_{portal_id}_portal",
        config_entry=entry,
        device_id=device.id,
    )
    registry.async_get_or_create(
        "sensor",
        DOMAIN,
        f"{DEPLOYMENT_ID}_{portal_id}_last_interaction",
        config_entry=entry,
        device_id=device.id,
    )


@pytest.fixture
async def live_entry(hass: HomeAssistant, entry: MockConfigEntry):
    """The entry set up and running, with control over what the next poll returns."""
    get_state = AsyncMock(return_value=STATE)

    with patch("custom_components.ha_guest_portal.PortalApi.async_get_state", get_state):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        yield entry, get_state


async def test_a_portal_re_added_under_the_same_id_gets_its_entities_back(
    hass: HomeAssistant, live_entry
):
    entry, get_state = live_entry
    registry = er.async_get(hass)
    coordinator = entry.runtime_data

    get_state.return_value = STATE_NO_PORTALS
    await coordinator.async_refresh()
    await hass.async_block_till_done()
    assert registry.async_get_entity_id("switch", DOMAIN, SWITCH_UNIQUE_ID) is None

    get_state.return_value = STATE
    await coordinator.async_refresh()
    await hass.async_block_till_done()

    entity_id = registry.async_get_entity_id("switch", DOMAIN, SWITCH_UNIQUE_ID)
    assert entity_id is not None
    assert hass.states.get(entity_id).state == "on"


async def test_an_emptied_portal_list_leaves_the_entry_loaded_with_nothing_on_it(
    hass: HomeAssistant, live_entry
):
    entry, get_state = live_entry

    get_state.return_value = STATE_NO_PORTALS
    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()

    registry = er.async_get(hass)
    assert er.async_entries_for_config_entry(registry, entry.entry_id) == []
    assert entry.state is ConfigEntryState.LOADED


async def test_a_failed_poll_keeps_the_entities_and_only_marks_them_unavailable(
    hass: HomeAssistant, live_entry
):
    entry, get_state = live_entry
    registry = er.async_get(hass)
    entity_id = registry.async_get_entity_id("switch", DOMAIN, SWITCH_UNIQUE_ID)

    get_state.side_effect = PortalConnectionError("the portal is not answering")
    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()

    assert registry.async_get_entity_id("switch", DOMAIN, SWITCH_UNIQUE_ID) == entity_id
    assert hass.states.get(entity_id).state == STATE_UNAVAILABLE
    assert (
        dr.async_get(hass).async_get_device_by_identifier(
            (DOMAIN, f"{DEPLOYMENT_ID}_timothy"), entry.entry_id
        )
        is not None
    )


async def test_a_portal_deleted_while_the_entry_was_down_is_reconciled_away(
    hass: HomeAssistant, entry: MockConfigEntry
):
    _register_portal(hass, entry, "ghost")
    _register_portal(hass, entry, "timothy")
    registry = er.async_get(hass)
    devices = dr.async_get(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    assert registry.async_get_entity_id("switch", DOMAIN, f"{DEPLOYMENT_ID}_ghost_portal") is None
    assert (
        registry.async_get_entity_id("sensor", DOMAIN, f"{DEPLOYMENT_ID}_ghost_last_interaction")
        is None
    )
    assert (
        devices.async_get_device_by_identifier((DOMAIN, f"{DEPLOYMENT_ID}_ghost"), entry.entry_id)
        is None
    )

    # The portal that still exists keeps everything it had.
    assert (
        registry.async_get_entity_id("switch", DOMAIN, f"{DEPLOYMENT_ID}_timothy_portal")
        is not None
    )
    assert (
        devices.async_get_device_by_identifier((DOMAIN, f"{DEPLOYMENT_ID}_timothy"), entry.entry_id)
        is not None
    )


async def test_a_portals_device_outlives_the_first_of_its_two_entities(
    hass: HomeAssistant, entry: MockConfigEntry
):
    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    registry = er.async_get(hass)
    devices = dr.async_get(hass)
    device_key = f"{DEPLOYMENT_ID}_timothy"

    # The switch platform has taken its own entity away; the sensor is still
    # live on the device they share.
    registry.async_remove(registry.async_get_entity_id("switch", DOMAIN, f"{device_key}_portal"))
    _remove_device_if_empty(registry, devices, device_key, entry.entry_id)
    await hass.async_block_till_done()

    assert devices.async_get_device_by_identifier((DOMAIN, device_key), entry.entry_id) is not None

    # Only when the sensor follows does the device go.
    registry.async_remove(
        registry.async_get_entity_id("sensor", DOMAIN, f"{device_key}_last_interaction")
    )
    _remove_device_if_empty(registry, devices, device_key, entry.entry_id)
    await hass.async_block_till_done()

    assert devices.async_get_device_by_identifier((DOMAIN, device_key), entry.entry_id) is None
