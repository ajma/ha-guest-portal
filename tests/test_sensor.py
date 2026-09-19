"""Tests for the Guest Portal interaction sensor."""

from dataclasses import replace
from unittest.mock import AsyncMock, patch

from homeassistant.const import STATE_UNKNOWN
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_guest_portal.api import Interaction
from custom_components.ha_guest_portal.const import CONF_TOKEN, DOMAIN
from tests.test_init import STATE

ENTITY_ID = "sensor.guest_portal_last_interaction"


async def _setup(hass: HomeAssistant, state):
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=state.portal_id,
        data={"host": "127.0.0.1", "port": 8080, CONF_TOKEN: "good-token"},
        title="Guest Portal",
    )
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=state),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    return entry


async def test_sensor_reports_the_interaction_timestamp(hass: HomeAssistant):
    await _setup(hass, STATE)

    state = hass.states.get(ENTITY_ID)

    assert state is not None
    # 1700000000000 ms == 2023-11-14T22:13:20+00:00
    assert state.state == "2023-11-14T22:13:20+00:00"


async def test_sensor_exposes_action_attributes(hass: HomeAssistant):
    await _setup(hass, STATE)

    attrs = hass.states.get(ENTITY_ID).attributes

    assert attrs["kind"] == "action"
    assert attrs["target_entity_id"] == "lock.front"
    assert attrs["label"] == "Front Door"
    assert attrs["action"] == "unlock"
    assert attrs["ok"] is True


async def test_sensor_uses_target_entity_id_not_entity_id(hass: HomeAssistant):
    await _setup(hass, STATE)

    # 'entity_id' as an attribute means group membership in Home Assistant.
    assert "entity_id" not in hass.states.get(ENTITY_ID).attributes


async def test_sensor_exposes_login_attributes_as_nulls(hass: HomeAssistant):
    login_state = replace(
        STATE,
        last_interaction=Interaction(
            ts=1700000000000, kind="login", entity_id=None, label=None, action=None, ok=True
        ),
    )
    await _setup(hass, login_state)

    attrs = hass.states.get(ENTITY_ID).attributes

    assert attrs["kind"] == "login"
    assert attrs["target_entity_id"] is None
    assert attrs["label"] is None
    assert attrs["action"] is None


async def test_sensor_is_unknown_before_any_interaction(hass: HomeAssistant):
    await _setup(hass, replace(STATE, last_interaction=None))

    assert hass.states.get(ENTITY_ID).state == STATE_UNKNOWN
