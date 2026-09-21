"""Tests for the shared Guest Portal entity base."""

from types import SimpleNamespace

import pytest

from custom_components.ha_guest_portal.api import DeploymentState, PortalSummary
from custom_components.ha_guest_portal.const import DOMAIN
from custom_components.ha_guest_portal.entity import GuestPortalEntity

DEPLOYMENT_STATE = DeploymentState(
    deployment_id="dep-1",
    ha_stale=False,
    version="1.2.3",
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
def coordinator_with_two_portals():
    """A lightweight stand-in for GuestPortalCoordinator with two portals."""
    return SimpleNamespace(data=DEPLOYMENT_STATE, api=SimpleNamespace(base_url="http://portal.local"))


def test_unique_id_and_device_combine_deployment_and_portal_id(coordinator_with_two_portals):
    entity = GuestPortalEntity(coordinator_with_two_portals, "portal-a", "switch")

    assert entity.unique_id == "dep-1_portal-a_switch"
    assert entity.device_info["identifiers"] == {(DOMAIN, "dep-1_portal-a")}
    assert entity.device_info["name"] == "Portal A"


def test_current_portal_finds_its_own_portal(coordinator_with_two_portals):
    entity = GuestPortalEntity(coordinator_with_two_portals, "portal-a", "switch")
    portal = entity._current_portal()
    assert portal is not None
    assert portal.portal_id == "portal-a"


def test_current_portal_returns_none_when_removed(coordinator_with_two_portals):
    entity = GuestPortalEntity(coordinator_with_two_portals, "portal-gone", "switch")
    assert entity._current_portal() is None
