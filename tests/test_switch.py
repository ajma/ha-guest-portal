"""Tests for the Guest Portal switch entity."""

from dataclasses import replace
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.const import ATTR_ENTITY_ID, STATE_OFF, STATE_ON, STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_guest_portal.api import PortalConnectionError
from custom_components.ha_guest_portal.const import CONF_TOKEN, DOMAIN
from tests.test_init import STATE

ENTITY_ID = "switch.guest_portal"


@pytest.fixture
async def setup_portal(hass: HomeAssistant):
    """Set up the integration with a controllable fake portal."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=STATE.portal_id,
        data={"host": "127.0.0.1", "port": 8080, CONF_TOKEN: "good-token"},
        title="Guest Portal",
    )
    entry.add_to_hass(hass)

    get_state = AsyncMock(return_value=STATE)
    set_enabled = AsyncMock()

    with (
        patch("custom_components.ha_guest_portal.PortalApi.async_get_state", get_state),
        patch("custom_components.ha_guest_portal.PortalApi.async_set_enabled", set_enabled),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        yield entry, get_state, set_enabled


async def test_switch_reports_enabled(hass: HomeAssistant, setup_portal):
    state = hass.states.get(ENTITY_ID)

    assert state is not None
    assert state.state == STATE_ON


async def test_switch_exposes_device_count_and_link_health(hass: HomeAssistant, setup_portal):
    state = hass.states.get(ENTITY_ID)

    assert state.attributes["device_count"] == 3
    assert state.attributes["ha_link_stale"] is False


async def test_turning_off_calls_the_portal(hass: HomeAssistant, setup_portal):
    _entry, get_state, set_enabled = setup_portal
    get_state.return_value = replace(STATE, enabled=False)

    await hass.services.async_call("switch", "turn_off", {ATTR_ENTITY_ID: ENTITY_ID}, blocking=True)

    set_enabled.assert_awaited_once_with(False)
    assert hass.states.get(ENTITY_ID).state == STATE_OFF


async def test_switch_goes_unavailable_when_the_portal_is_unreachable(
    hass: HomeAssistant, setup_portal
):
    entry, get_state, _set_enabled = setup_portal
    get_state.side_effect = PortalConnectionError("gone")

    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()

    assert hass.states.get(ENTITY_ID).state == STATE_UNAVAILABLE
