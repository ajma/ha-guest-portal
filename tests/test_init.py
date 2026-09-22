"""Tests for entry setup and the update coordinator."""

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_guest_portal.api import (
    DeploymentState,
    Interaction,
    PortalAuthError,
    PortalConnectionError,
    PortalSummary,
)
from custom_components.ha_guest_portal.const import CONF_TOKEN, DOMAIN

STATE = DeploymentState(
    deployment_id="11111111-1111-1111-1111-111111111111",
    ha_stale=False,
    version="2.0.0",
    portals=[
        PortalSummary(
            portal_id="portal-1",
            title="Guest Portal",
            enabled=True,
            device_count=3,
            last_interaction=Interaction(
                ts=1700000000000,
                kind="action",
                entity_id="lock.front",
                label="Front Door",
                action="unlock",
                ok=True,
            ),
        ),
    ],
)


# The raw body a pre-multi-portal add-on serves, as it comes off the wire.
LEGACY_PAYLOAD = {
    "portalId": "11111111-1111-1111-1111-111111111111",
    "enabled": True,
    "haStale": False,
    "deviceCount": 3,
    "version": "1.4.0",
    "lastInteraction": None,
}


@pytest.fixture
def entry() -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN,
        unique_id="11111111-1111-1111-1111-111111111111",
        data={CONF_HOST: "127.0.0.1", CONF_PORT: 8080, CONF_TOKEN: "good-token"},
        title="Guest Portal",
    )


async def test_setup_entry_loads(hass: HomeAssistant, entry: MockConfigEntry):
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.LOADED
    assert entry.runtime_data.data == STATE


async def test_setup_entry_retries_when_the_portal_is_unreachable(
    hass: HomeAssistant, entry: MockConfigEntry
):
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(side_effect=PortalConnectionError("nope")),
    ):
        await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.SETUP_RETRY


async def test_setup_entry_starts_reauth_on_a_rejected_token(
    hass: HomeAssistant, entry: MockConfigEntry
):
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(side_effect=PortalAuthError("nope")),
    ):
        await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.SETUP_ERROR
    flows = hass.config_entries.flow.async_progress()
    assert any(flow["context"]["source"] == "reauth" for flow in flows)


async def test_unload_entry(hass: HomeAssistant, entry: MockConfigEntry):
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

        assert await hass.config_entries.async_unload(entry.entry_id)
        await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.NOT_LOADED


async def test_an_old_portal_raises_a_repair_issue(hass: HomeAssistant, entry: MockConfigEntry):
    from dataclasses import replace

    from homeassistant.helpers import issue_registry as ir

    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=replace(STATE, version="0.9.0")),
    ):
        await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    registry = ir.async_get(hass)
    assert registry.async_get_issue(DOMAIN, f"portal_too_old_{entry.entry_id}") is not None
    assert entry.state is ConfigEntryState.SETUP_RETRY


async def test_a_current_portal_raises_no_repair_issue(hass: HomeAssistant, entry: MockConfigEntry):
    from homeassistant.helpers import issue_registry as ir

    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    registry = ir.async_get(hass)
    assert registry.async_get_issue(DOMAIN, f"portal_too_old_{entry.entry_id}") is None


async def test_upgrading_the_portal_clears_the_repair_issue(
    hass: HomeAssistant, entry: MockConfigEntry
):
    from dataclasses import replace

    from homeassistant.helpers import issue_registry as ir

    entry.add_to_hass(hass)

    # Start with an old portal version that raises a repair issue
    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=replace(STATE, version="0.9.0")),
    ):
        await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    registry = ir.async_get(hass)
    issue_id = f"portal_too_old_{entry.entry_id}"
    assert registry.async_get_issue(DOMAIN, issue_id) is not None

    # Unload the entry (simulating a restart after the add-on update)
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    # Reload with an updated portal version
    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    # The repair issue should now be cleared
    assert registry.async_get_issue(DOMAIN, issue_id) is None


async def test_missing_version_raises_a_repair_issue(hass: HomeAssistant, entry: MockConfigEntry):
    from dataclasses import replace

    from homeassistant.helpers import issue_registry as ir

    entry.add_to_hass(hass)

    # A portal that returns no version field should raise a repair issue
    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=replace(STATE, version="0.0.0")),
    ):
        await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    registry = ir.async_get(hass)
    assert registry.async_get_issue(DOMAIN, f"portal_too_old_{entry.entry_id}") is not None


async def test_a_1_x_add_on_raises_the_repair_issue_rather_than_loading_empty(
    hass: HomeAssistant, entry: MockConfigEntry
):
    from homeassistant.helpers import issue_registry as ir

    entry.add_to_hass(hass)

    # Patched at the transport, so the real parser sees the real 1.x body.
    with patch(
        "custom_components.ha_guest_portal.PortalApi._request",
        AsyncMock(return_value=LEGACY_PAYLOAD),
    ):
        await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    registry = ir.async_get(hass)
    assert registry.async_get_issue(DOMAIN, f"portal_too_old_{entry.entry_id}") is not None
    # Loading would mean an entry reporting zero portals, which reads as every
    # portal having been deleted.
    assert entry.state is ConfigEntryState.SETUP_RETRY


async def test_a_replaced_deployment_stops_the_old_entry(
    hass: HomeAssistant, entry: MockConfigEntry
):
    from dataclasses import replace

    entry.add_to_hass(hass)

    # What deleting the add-on's database looks like: a brand new deployment id
    # on the address this entry was configured against.
    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(
            return_value=replace(STATE, deployment_id="22222222-2222-2222-2222-222222222222")
        ),
    ):
        await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.SETUP_ERROR


async def test_unparseable_version_raises_a_repair_issue(
    hass: HomeAssistant, entry: MockConfigEntry
):
    from dataclasses import replace

    from homeassistant.helpers import issue_registry as ir

    entry.add_to_hass(hass)

    # A portal that returns garbage for the version should raise a repair issue
    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=replace(STATE, version="garbage")),
    ):
        await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    registry = ir.async_get(hass)
    assert registry.async_get_issue(DOMAIN, f"portal_too_old_{entry.entry_id}") is not None


async def _remove_device(hass_ws_client, hass: HomeAssistant, device_id: str):
    """Ask Home Assistant to delete a device, the way its device page does."""
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {
            "type": "config/device_registry/remove",
            "device_id": device_id,
        }
    )
    return await client.receive_json()


async def test_an_orphaned_device_can_be_deleted_from_its_device_page(
    hass: HomeAssistant, hass_ws_client, entry: MockConfigEntry
):
    from homeassistant.helpers import device_registry as dr
    from homeassistant.setup import async_setup_component

    assert await async_setup_component(hass, "config", {})
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    devices = dr.async_get(hass)
    orphan = devices.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, f"{STATE.deployment_id}_ghost")},
        name="Ghost",
    )

    response = await _remove_device(hass_ws_client, hass, orphan.id)

    assert response["success"], response
    assert devices.async_get(orphan.id) is None


async def test_a_live_portals_device_cannot_be_deleted(
    hass: HomeAssistant, hass_ws_client, entry: MockConfigEntry
):
    from homeassistant.helpers import device_registry as dr
    from homeassistant.setup import async_setup_component

    assert await async_setup_component(hass, "config", {})
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    devices = dr.async_get(hass)
    live = devices.async_get_device_by_identifier(
        (DOMAIN, f"{STATE.deployment_id}_{STATE.portals[0].portal_id}"), entry.entry_id
    )
    assert live is not None

    response = await _remove_device(hass_ws_client, hass, live.id)

    assert not response["success"]
    assert devices.async_get(live.id) is not None
