"""Tests for the Guest Portal switch entity."""

from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.const import ATTR_ENTITY_ID, STATE_OFF, STATE_ON
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_guest_portal.api import DeploymentState, PortalSummary
from custom_components.ha_guest_portal.const import CONF_TOKEN, DOMAIN
from custom_components.ha_guest_portal.switch import GuestPortalSwitch

DEPLOYMENT_ID = "dep-1"


def _portal(portal_id: str, *, enabled: bool = True, device_count: int = 0) -> PortalSummary:
    return PortalSummary(
        portal_id=portal_id,
        title=portal_id,
        enabled=enabled,
        device_count=device_count,
        last_interaction=None,
    )


STATE_ONE_PORTAL = DeploymentState(
    deployment_id=DEPLOYMENT_ID,
    ha_stale=False,
    version="2.0.0",
    portals=[_portal("timothy", enabled=True, device_count=3)],
)

STATE_TWO_PORTALS = DeploymentState(
    deployment_id=DEPLOYMENT_ID,
    ha_stale=False,
    version="2.0.0",
    portals=[
        _portal("timothy", enabled=True, device_count=3),
        _portal("mary", enabled=False, device_count=1),
    ],
)

STATE_ONE_PORTAL_REMAINING = DeploymentState(
    deployment_id=DEPLOYMENT_ID,
    ha_stale=False,
    version="2.0.0",
    portals=[_portal("mary", enabled=False, device_count=1)],
)


def _stub_coordinator(
    state: DeploymentState, *, last_update_success: bool = True
) -> SimpleNamespace:
    return SimpleNamespace(
        data=state,
        api=SimpleNamespace(base_url="http://portal.local"),
        last_update_success=last_update_success,
    )


def _switch_entity_id(hass: HomeAssistant, entry: MockConfigEntry, portal_id: str) -> str:
    registry = er.async_get(hass)
    unique_id = f"{DEPLOYMENT_ID}_{portal_id}_portal"
    entity_id = registry.async_get_entity_id("switch", DOMAIN, unique_id)
    assert entity_id is not None, f"no switch registered for portal {portal_id}"
    return entity_id


def _switch_count(hass: HomeAssistant, entry: MockConfigEntry) -> int:
    """Count only this integration's switch entities.

    `async_entries_for_config_entry` also returns the sensor entities the same
    config entry sets up, so counting switches specifically means filtering by
    domain rather than using the raw total.
    """
    registry = er.async_get(hass)
    return len(
        [
            e
            for e in er.async_entries_for_config_entry(registry, entry.entry_id)
            if e.domain == "switch"
        ]
    )


@pytest.fixture
async def mock_config_entry_with_one_portal(hass: HomeAssistant):
    """A config entry set up against a portal currently reporting one guest portal."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=DEPLOYMENT_ID,
        data={"host": "127.0.0.1", "port": 8080, CONF_TOKEN: "good-token"},
        title="Guest Portal",
    )
    entry.add_to_hass(hass)

    get_state = AsyncMock(return_value=STATE_ONE_PORTAL)
    set_enabled = AsyncMock()

    with (
        patch("custom_components.ha_guest_portal.PortalApi.async_get_state", get_state),
        patch("custom_components.ha_guest_portal.PortalApi.async_set_enabled", set_enabled),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        yield entry, get_state, set_enabled


@pytest.fixture
async def mock_config_entry_with_two_portals(hass: HomeAssistant):
    """A config entry set up against a portal currently reporting two guest portals."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=DEPLOYMENT_ID,
        data={"host": "127.0.0.1", "port": 8080, CONF_TOKEN: "good-token"},
        title="Guest Portal",
    )
    entry.add_to_hass(hass)

    get_state = AsyncMock(return_value=STATE_TWO_PORTALS)
    set_enabled = AsyncMock()

    with (
        patch("custom_components.ha_guest_portal.PortalApi.async_get_state", get_state),
        patch("custom_components.ha_guest_portal.PortalApi.async_set_enabled", set_enabled),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        yield entry, get_state, set_enabled


async def test_creates_one_switch_per_portal(
    hass: HomeAssistant, mock_config_entry_with_two_portals
):
    entry, _get_state, _set_enabled = mock_config_entry_with_two_portals

    timothy_id = _switch_entity_id(hass, entry, "timothy")
    mary_id = _switch_entity_id(hass, entry, "mary")

    assert hass.states.get(timothy_id).state == STATE_ON
    assert hass.states.get(mary_id).state == STATE_OFF


async def test_switch_exposes_device_count_and_link_health_per_portal(
    hass: HomeAssistant, mock_config_entry_with_two_portals
):
    entry, _get_state, _set_enabled = mock_config_entry_with_two_portals

    timothy_attrs = hass.states.get(_switch_entity_id(hass, entry, "timothy")).attributes
    mary_attrs = hass.states.get(_switch_entity_id(hass, entry, "mary")).attributes

    assert timothy_attrs["device_count"] == 3
    assert timothy_attrs["ha_link_stale"] is False
    assert mary_attrs["device_count"] == 1


async def test_turning_off_calls_the_portal_with_its_own_portal_id(
    hass: HomeAssistant, mock_config_entry_with_two_portals
):
    entry, get_state, set_enabled = mock_config_entry_with_two_portals
    timothy_id = _switch_entity_id(hass, entry, "timothy")
    get_state.return_value = replace(
        STATE_TWO_PORTALS,
        portals=[
            replace(STATE_TWO_PORTALS.portals[0], enabled=False),
            STATE_TWO_PORTALS.portals[1],
        ],
    )

    await hass.services.async_call(
        "switch", "turn_off", {ATTR_ENTITY_ID: timothy_id}, blocking=True
    )

    set_enabled.assert_awaited_once_with("timothy", False)
    assert hass.states.get(timothy_id).state == STATE_OFF


async def test_adds_a_switch_when_a_new_portal_appears_on_a_later_poll(
    hass: HomeAssistant, mock_config_entry_with_one_portal
):
    entry, get_state, _set_enabled = mock_config_entry_with_one_portal
    assert _switch_count(hass, entry) == 1

    get_state.return_value = STATE_TWO_PORTALS
    coordinator = entry.runtime_data
    await coordinator.async_request_refresh()
    await hass.async_block_till_done()

    assert _switch_count(hass, entry) == 2
    mary_id = _switch_entity_id(hass, entry, "mary")
    assert hass.states.get(mary_id) is not None
    assert hass.states.get(mary_id).state == STATE_OFF


async def test_removes_a_switch_when_its_portal_is_deleted(
    hass: HomeAssistant, mock_config_entry_with_two_portals
):
    entry, get_state, _set_enabled = mock_config_entry_with_two_portals
    registry = er.async_get(hass)
    assert _switch_count(hass, entry) == 2
    mary_id = _switch_entity_id(hass, entry, "mary")

    get_state.return_value = STATE_ONE_PORTAL_REMAINING
    coordinator = entry.runtime_data
    await coordinator.async_request_refresh()
    await hass.async_block_till_done()

    assert _switch_count(hass, entry) == 1
    assert registry.async_get_entity_id("switch", DOMAIN, f"{DEPLOYMENT_ID}_timothy_portal") is None
    assert hass.states.get(mary_id).state == STATE_OFF


async def test_removes_the_device_when_its_portal_is_deleted(
    hass: HomeAssistant, mock_config_entry_with_two_portals
):
    entry, get_state, _set_enabled = mock_config_entry_with_two_portals
    devices = dr.async_get(hass)
    assert devices.async_get_device_by_identifier(
        (DOMAIN, f"{DEPLOYMENT_ID}_timothy"), entry.entry_id
    ) is not None

    get_state.return_value = STATE_ONE_PORTAL_REMAINING
    coordinator = entry.runtime_data
    await coordinator.async_request_refresh()
    await hass.async_block_till_done()

    assert devices.async_get_device_by_identifier(
        (DOMAIN, f"{DEPLOYMENT_ID}_timothy"), entry.entry_id
    ) is None
    assert devices.async_get_device_by_identifier(
        (DOMAIN, f"{DEPLOYMENT_ID}_mary"), entry.entry_id
    ) is not None


def test_available_is_false_once_the_portal_is_gone():
    switch = GuestPortalSwitch(_stub_coordinator(STATE_ONE_PORTAL), "gone")
    assert switch.available is False


def test_is_on_is_false_when_the_portal_is_gone():
    switch = GuestPortalSwitch(_stub_coordinator(STATE_ONE_PORTAL), "gone")
    assert switch.is_on is False


def test_extra_state_attributes_is_empty_when_the_portal_is_gone():
    switch = GuestPortalSwitch(_stub_coordinator(STATE_ONE_PORTAL), "gone")
    assert switch.extra_state_attributes == {}
