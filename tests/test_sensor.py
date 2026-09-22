"""Tests for the Guest Portal interaction sensor."""

from dataclasses import replace
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.const import STATE_UNKNOWN
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_guest_portal.api import DeploymentState, Interaction, PortalSummary
from custom_components.ha_guest_portal.const import CONF_TOKEN, DOMAIN
from custom_components.ha_guest_portal.sensor import GuestPortalLastInteraction

DEPLOYMENT_ID = "dep-1"

TIMOTHY_INTERACTION = Interaction(
    ts=1700000000000,
    kind="action",
    entity_id="lock.front",
    label="Front Door",
    action="unlock",
    ok=True,
)

MARY_INTERACTION = Interaction(
    ts=1700000100000,
    kind="action",
    entity_id="lock.back",
    label="Back Door",
    action="lock",
    ok=True,
)


def _portal(portal_id: str, *, last_interaction: Interaction | None) -> PortalSummary:
    return PortalSummary(
        portal_id=portal_id,
        title=portal_id,
        enabled=True,
        device_count=0,
        last_interaction=last_interaction,
    )


STATE_ONE_PORTAL = DeploymentState(
    deployment_id=DEPLOYMENT_ID,
    ha_stale=False,
    version="2.0.0",
    portals=[_portal("timothy", last_interaction=TIMOTHY_INTERACTION)],
)

STATE_TWO_PORTALS = DeploymentState(
    deployment_id=DEPLOYMENT_ID,
    ha_stale=False,
    version="2.0.0",
    portals=[
        _portal("timothy", last_interaction=TIMOTHY_INTERACTION),
        _portal("mary", last_interaction=MARY_INTERACTION),
    ],
)

STATE_ONE_PORTAL_REMAINING = DeploymentState(
    deployment_id=DEPLOYMENT_ID,
    ha_stale=False,
    version="2.0.0",
    portals=[_portal("mary", last_interaction=MARY_INTERACTION)],
)


def _sensor_entity_id(hass: HomeAssistant, portal_id: str) -> str:
    registry = er.async_get(hass)
    unique_id = f"{DEPLOYMENT_ID}_{portal_id}_last_interaction"
    entity_id = registry.async_get_entity_id("sensor", DOMAIN, unique_id)
    assert entity_id is not None, f"no sensor registered for portal {portal_id}"
    return entity_id


def _sensor_count(hass: HomeAssistant, entry: MockConfigEntry) -> int:
    """Count only this integration's sensor entities.

    `async_entries_for_config_entry` also returns the switch entities the same
    config entry sets up, so counting sensors specifically means filtering by
    domain rather than using the raw total.
    """
    registry = er.async_get(hass)
    return len(
        [
            e
            for e in er.async_entries_for_config_entry(registry, entry.entry_id)
            if e.domain == "sensor"
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

    with patch("custom_components.ha_guest_portal.PortalApi.async_get_state", get_state):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        yield entry, get_state


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

    with patch("custom_components.ha_guest_portal.PortalApi.async_get_state", get_state):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        yield entry, get_state


async def test_creates_one_sensor_per_portal(
    hass: HomeAssistant, mock_config_entry_with_two_portals
):
    entry, _get_state = mock_config_entry_with_two_portals

    timothy_id = _sensor_entity_id(hass, "timothy")
    mary_id = _sensor_entity_id(hass, "mary")

    # 1700000000000 ms == 2023-11-14T22:13:20+00:00
    assert hass.states.get(timothy_id).state == "2023-11-14T22:13:20+00:00"
    # 1700000100000 ms == 2023-11-14T22:15:00+00:00
    assert hass.states.get(mary_id).state == "2023-11-14T22:15:00+00:00"


async def test_sensor_exposes_action_attributes_per_portal(
    hass: HomeAssistant, mock_config_entry_with_two_portals
):
    entry, _get_state = mock_config_entry_with_two_portals

    timothy_attrs = hass.states.get(_sensor_entity_id(hass, "timothy")).attributes
    mary_attrs = hass.states.get(_sensor_entity_id(hass, "mary")).attributes

    assert timothy_attrs["kind"] == "action"
    assert timothy_attrs["target_entity_id"] == "lock.front"
    assert timothy_attrs["label"] == "Front Door"
    assert timothy_attrs["action"] == "unlock"
    assert timothy_attrs["ok"] is True

    assert mary_attrs["target_entity_id"] == "lock.back"
    assert mary_attrs["action"] == "lock"


async def test_sensor_uses_target_entity_id_not_entity_id(
    hass: HomeAssistant, mock_config_entry_with_one_portal
):
    entry, _get_state = mock_config_entry_with_one_portal

    # 'entity_id' as an attribute means group membership in Home Assistant.
    attrs = hass.states.get(_sensor_entity_id(hass, "timothy")).attributes
    assert "entity_id" not in attrs


async def test_sensor_exposes_login_attributes_as_nulls(
    hass: HomeAssistant, mock_config_entry_with_one_portal
):
    entry, get_state = mock_config_entry_with_one_portal
    login_interaction = Interaction(
        ts=1700000000000, kind="login", entity_id=None, label=None, action=None, ok=True
    )
    get_state.return_value = replace(
        STATE_ONE_PORTAL,
        portals=[replace(STATE_ONE_PORTAL.portals[0], last_interaction=login_interaction)],
    )
    coordinator = entry.runtime_data
    await coordinator.async_request_refresh()
    await hass.async_block_till_done()

    attrs = hass.states.get(_sensor_entity_id(hass, "timothy")).attributes

    assert attrs["kind"] == "login"
    assert attrs["target_entity_id"] is None
    assert attrs["label"] is None
    assert attrs["action"] is None


async def test_sensor_is_unknown_before_any_interaction(
    hass: HomeAssistant, mock_config_entry_with_one_portal
):
    entry, get_state = mock_config_entry_with_one_portal
    get_state.return_value = replace(
        STATE_ONE_PORTAL,
        portals=[replace(STATE_ONE_PORTAL.portals[0], last_interaction=None)],
    )
    coordinator = entry.runtime_data
    await coordinator.async_request_refresh()
    await hass.async_block_till_done()

    assert hass.states.get(_sensor_entity_id(hass, "timothy")).state == STATE_UNKNOWN


async def test_adds_a_sensor_when_a_new_portal_appears_on_a_later_poll(
    hass: HomeAssistant, mock_config_entry_with_one_portal
):
    entry, get_state = mock_config_entry_with_one_portal
    assert _sensor_count(hass, entry) == 1

    get_state.return_value = STATE_TWO_PORTALS
    coordinator = entry.runtime_data
    await coordinator.async_request_refresh()
    await hass.async_block_till_done()

    assert _sensor_count(hass, entry) == 2
    mary_id = _sensor_entity_id(hass, "mary")
    assert hass.states.get(mary_id) is not None
    assert hass.states.get(mary_id).state == "2023-11-14T22:15:00+00:00"


async def test_removes_a_sensor_when_its_portal_is_deleted(
    hass: HomeAssistant, mock_config_entry_with_two_portals
):
    entry, get_state = mock_config_entry_with_two_portals
    registry = er.async_get(hass)
    assert _sensor_count(hass, entry) == 2
    mary_id = _sensor_entity_id(hass, "mary")

    get_state.return_value = STATE_ONE_PORTAL_REMAINING
    coordinator = entry.runtime_data
    await coordinator.async_request_refresh()
    await hass.async_block_till_done()

    assert _sensor_count(hass, entry) == 1
    assert (
        registry.async_get_entity_id("sensor", DOMAIN, f"{DEPLOYMENT_ID}_timothy_last_interaction")
        is None
    )
    assert hass.states.get(mary_id).state == "2023-11-14T22:15:00+00:00"


async def test_removes_the_device_when_its_portal_is_deleted(
    hass: HomeAssistant, mock_config_entry_with_two_portals
):
    entry, get_state = mock_config_entry_with_two_portals
    devices = dr.async_get(hass)
    assert (
        devices.async_get_device_by_identifier((DOMAIN, f"{DEPLOYMENT_ID}_timothy"), entry.entry_id)
        is not None
    )

    get_state.return_value = STATE_ONE_PORTAL_REMAINING
    coordinator = entry.runtime_data
    await coordinator.async_request_refresh()
    await hass.async_block_till_done()

    assert (
        devices.async_get_device_by_identifier((DOMAIN, f"{DEPLOYMENT_ID}_timothy"), entry.entry_id)
        is None
    )
    assert (
        devices.async_get_device_by_identifier((DOMAIN, f"{DEPLOYMENT_ID}_mary"), entry.entry_id)
        is not None
    )


async def test_available_is_false_once_the_portal_is_gone(mock_config_entry_with_one_portal):
    entry, _get_state = mock_config_entry_with_one_portal
    sensor = GuestPortalLastInteraction(entry.runtime_data, "gone")
    assert sensor.available is False


async def test_native_value_is_none_when_the_portal_is_gone(mock_config_entry_with_one_portal):
    entry, _get_state = mock_config_entry_with_one_portal
    sensor = GuestPortalLastInteraction(entry.runtime_data, "gone")
    assert sensor.native_value is None


async def test_extra_state_attributes_is_empty_when_the_portal_is_gone(
    mock_config_entry_with_one_portal,
):
    entry, _get_state = mock_config_entry_with_one_portal
    sensor = GuestPortalLastInteraction(entry.runtime_data, "gone")
    assert sensor.extra_state_attributes == {}
