"""Tests for the Guest Portal config flow."""

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_guest_portal.api import (
    DeploymentState,
    PortalAuthError,
    PortalConnectionError,
    PortalSummary,
)
from custom_components.ha_guest_portal.const import CONF_TOKEN, DOMAIN

# The deployment's own identity, as returned by /api/integration/state and
# used as the config entry's unique id.
DEPLOYMENT_ID = "11111111-1111-1111-1111-111111111111"

# The Supervisor discovery payload's "portalId" key, which is a separate,
# unrelated identity from the deployment's — see config_flow.py.
PORTAL_ID = "22222222-2222-2222-2222-222222222222"

STATE = DeploymentState(
    deployment_id=DEPLOYMENT_ID,
    ha_stale=False,
    version="2.0.0",
    portals=[
        PortalSummary(
            portal_id="p1",
            title="Guest Portal",
            enabled=True,
            device_count=3,
            last_interaction=None,
        )
    ],
)

USER_INPUT = {CONF_HOST: "192.168.1.50", CONF_PORT: 8080, CONF_TOKEN: "good-token"}

DISCOVERY = HassioServiceInfo(
    config={
        "portalId": PORTAL_ID,
        "host": "local-ha-guest-portal",
        "port": 8080,
        "token": "good-token",
    },
    name="Home Assistant Guest Portal",
    slug="local_ha_guest_portal",
    uuid="abcdef",
)


@pytest.fixture
def mock_state():
    with patch(
        "custom_components.ha_guest_portal.config_flow.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ) as mocked:
        yield mocked


@pytest.fixture(autouse=True)
def mock_setup_entry():
    with patch(
        "custom_components.ha_guest_portal.async_setup_entry", AsyncMock(return_value=True)
    ) as mocked:
        yield mocked


async def test_user_flow_creates_an_entry(hass: HomeAssistant, mock_state):
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["result"].unique_id == DEPLOYMENT_ID
    assert result["data"] == USER_INPUT


async def test_user_flow_reports_a_bad_token(hass: HomeAssistant):
    with patch(
        "custom_components.ha_guest_portal.config_flow.PortalApi.async_get_state",
        AsyncMock(side_effect=PortalAuthError("no")),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": config_entries.SOURCE_USER}
        )
        result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}


async def test_user_flow_reports_an_unreachable_portal(hass: HomeAssistant):
    with patch(
        "custom_components.ha_guest_portal.config_flow.PortalApi.async_get_state",
        AsyncMock(side_effect=PortalConnectionError("no")),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": config_entries.SOURCE_USER}
        )
        result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_user_flow_rejects_a_duplicate_portal(hass: HomeAssistant, mock_state):
    MockConfigEntry(domain=DOMAIN, unique_id=DEPLOYMENT_ID, data=USER_INPUT).add_to_hass(hass)

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_hassio_discovery_creates_an_entry(hass: HomeAssistant, mock_state):
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_HASSIO}, data=DISCOVERY
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "hassio_confirm"

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["result"].unique_id == PORTAL_ID
    assert result["data"] == {
        CONF_HOST: "local-ha-guest-portal",
        CONF_PORT: 8080,
        CONF_TOKEN: "good-token",
    }


async def test_hassio_discovery_aborts_for_a_manually_added_portal(hass: HomeAssistant):
    MockConfigEntry(domain=DOMAIN, unique_id=PORTAL_ID, data=USER_INPUT).add_to_hass(hass)

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_HASSIO}, data=DISCOVERY
    )

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_hassio_discovery_aborts_for_a_malformed_payload(hass: HomeAssistant):
    malformed_discovery = HassioServiceInfo(
        config={"portalId": PORTAL_ID, "port": 8080, "token": "good-token"},
        name="Home Assistant Guest Portal",
        slug="local_ha_guest_portal",
        uuid="abcdef",
    )

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_HASSIO}, data=malformed_discovery
    )

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "cannot_connect"


async def test_reauth_updates_the_token(hass: HomeAssistant, mock_state):
    entry = MockConfigEntry(domain=DOMAIN, unique_id=PORTAL_ID, data=USER_INPUT)
    entry.add_to_hass(hass)

    result = await entry.start_reauth_flow(hass)
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_TOKEN: "fresh-token"}
    )

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert entry.data[CONF_TOKEN] == "fresh-token"
