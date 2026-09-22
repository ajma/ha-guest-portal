"""Tests for the shared Guest Portal entity base."""

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_guest_portal.api import DeploymentState, PortalSummary
from custom_components.ha_guest_portal.const import CONF_TOKEN, DOMAIN
from custom_components.ha_guest_portal.entity import GuestPortalEntity

DEPLOYMENT_STATE = DeploymentState(
    deployment_id="dep-1",
    ha_stale=False,
    version="2.0.0",
    portals=[
        PortalSummary(
            portal_id="portal-a",
            title="Portal A",
            enabled=True,
            device_count=1,
            last_interaction=None,
        ),
        PortalSummary(
            portal_id="portal-b",
            title="Portal B",
            enabled=True,
            device_count=2,
            last_interaction=None,
        ),
    ],
)


@pytest.fixture
async def coordinator_with_two_portals(hass: HomeAssistant):
    """The real coordinator of an entry set up against a two-portal deployment."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id="dep-1",
        data={"host": "portal.local", "port": 8080, CONF_TOKEN: "good-token"},
        title="Guest Portal",
    )
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=DEPLOYMENT_STATE),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        yield entry.runtime_data


async def test_unique_id_and_device_combine_deployment_and_portal_id(coordinator_with_two_portals):
    entity = GuestPortalEntity(coordinator_with_two_portals, "portal-a", "switch")

    assert entity.unique_id == "dep-1_portal-a_switch"
    assert entity.device_info["identifiers"] == {(DOMAIN, "dep-1_portal-a")}
    assert entity.device_info["name"] == "Portal A"


async def test_a_portals_device_hangs_off_the_deployments_own_device(
    hass: HomeAssistant, coordinator_with_two_portals
):
    from homeassistant.helpers import device_registry as dr

    entity = GuestPortalEntity(coordinator_with_two_portals, "portal-a", "switch")

    hub = dr.async_get(hass).async_get_device_by_identifier(
        (DOMAIN, "dep-1"), coordinator_with_two_portals.config_entry.entry_id
    )
    assert hub is not None
    assert entity.device_info["via_device_id"] == hub.id


async def test_current_portal_finds_its_own_portal(coordinator_with_two_portals):
    entity = GuestPortalEntity(coordinator_with_two_portals, "portal-a", "switch")
    portal = entity._current_portal()
    assert portal is not None
    assert portal.portal_id == "portal-a"


async def test_current_portal_returns_none_when_removed(coordinator_with_two_portals):
    entity = GuestPortalEntity(coordinator_with_two_portals, "portal-gone", "switch")
    assert entity._current_portal() is None
