"""Tests for the Guest Portal HTTP client."""

import pytest
from aiohttp import ClientSession, web

from custom_components.ha_guest_portal.api import (
    PortalApi,
    PortalAuthError,
    PortalConnectionError,
)

pytestmark = pytest.mark.enable_socket()

STATE = {
    "deploymentId": "dep-1",
    "haStale": False,
    "version": "2.0.0",
    "portals": [
        {
            "portalId": "11111111-1111-1111-1111-111111111111",
            "title": "Timothy",
            "enabled": True,
            "deviceCount": 3,
            "lastInteraction": {
                "ts": 1700000000000,
                "kind": "action",
                "entityId": "lock.front",
                "label": "Front Door",
                "action": "unlock",
                "ok": True,
            },
        },
    ],
}


# What a pre-multi-portal add-on answers with: one portal inline, no list and
# no deployment id.
LEGACY_STATE = {
    "portalId": "11111111-1111-1111-1111-111111111111",
    "enabled": True,
    "haStale": False,
    "deviceCount": 3,
    "version": "1.4.0",
    "lastInteraction": None,
}


@pytest.fixture
async def portal(aiohttp_server):
    """Serve a stub portal and return (api, recorded_requests)."""
    recorded: list[dict] = []

    async def handle_state(request: web.Request) -> web.Response:
        recorded.append({"path": request.path, "auth": request.headers.get("Authorization")})
        if request.headers.get("Authorization") != "Bearer good-token":
            return web.json_response({"error": "Unauthorized"}, status=401)
        return web.json_response(STATE)

    async def handle_enabled(request: web.Request) -> web.Response:
        body = await request.json()
        recorded.append(
            {
                "path": request.path,
                "portal_id": request.match_info["portal_id"],
                "body": body,
            }
        )
        if request.headers.get("Authorization") != "Bearer good-token":
            return web.json_response({"error": "Unauthorized"}, status=401)
        return web.json_response({"enabled": body["enabled"]})

    app = web.Application()
    app.router.add_get("/api/integration/state", handle_state)
    app.router.add_post("/api/integration/portals/{portal_id}/enabled", handle_enabled)

    server = await aiohttp_server(app)

    async with ClientSession() as session:
        yield PortalApi(session, "127.0.0.1", server.port, "good-token"), recorded


async def test_get_state_parses_the_payload(portal):
    api, _ = portal

    state = await api.async_get_state()

    assert state.deployment_id == "dep-1"
    assert state.ha_stale is False
    assert state.version == "2.0.0"
    assert len(state.portals) == 1

    portal_summary = state.portals[0]
    assert portal_summary.portal_id == "11111111-1111-1111-1111-111111111111"
    assert portal_summary.title == "Timothy"
    assert portal_summary.enabled is True
    assert portal_summary.device_count == 3
    assert portal_summary.last_interaction is not None
    assert portal_summary.last_interaction.entity_id == "lock.front"
    assert portal_summary.last_interaction.kind == "action"


async def test_get_state_sends_the_bearer_token(portal):
    api, recorded = portal

    await api.async_get_state()

    assert recorded[0]["auth"] == "Bearer good-token"


async def test_get_state_handles_a_null_interaction(aiohttp_server):
    async def handle(_request: web.Request) -> web.Response:
        payload = {
            **STATE,
            "portals": [{**STATE["portals"][0], "lastInteraction": None}],
        }
        return web.json_response(payload)

    app = web.Application()
    app.router.add_get("/api/integration/state", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "good-token")
        state = await api.async_get_state()

    assert state.portals[0].last_interaction is None


async def test_get_state_raises_auth_error_on_401(aiohttp_server):
    async def handle(_request: web.Request) -> web.Response:
        return web.json_response({"error": "Unauthorized"}, status=401)

    app = web.Application()
    app.router.add_get("/api/integration/state", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "bad-token")
        with pytest.raises(PortalAuthError):
            await api.async_get_state()


async def test_get_state_raises_connection_error_when_unreachable():
    async with ClientSession() as session:
        # Port 1 is reserved and never listening.
        api = PortalApi(session, "127.0.0.1", 1, "good-token")
        with pytest.raises(PortalConnectionError):
            await api.async_get_state()


async def test_get_state_raises_connection_error_on_a_malformed_payload(aiohttp_server):
    async def handle(_request: web.Request) -> web.Response:
        return web.json_response({"nonsense": True})

    app = web.Application()
    app.router.add_get("/api/integration/state", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "good-token")
        with pytest.raises(PortalConnectionError):
            await api.async_get_state()


async def test_get_state_raises_connection_error_on_a_payload_that_is_not_an_object(
    aiohttp_server,
):
    async def handle(_request: web.Request) -> web.Response:
        return web.json_response([])

    app = web.Application()
    app.router.add_get("/api/integration/state", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "good-token")
        with pytest.raises(PortalConnectionError):
            await api.async_get_state()


async def test_get_state_reads_a_1_x_payload_as_an_empty_deployment(aiohttp_server):
    async def handle(_request: web.Request) -> web.Response:
        return web.json_response(LEGACY_STATE)

    app = web.Application()
    app.router.add_get("/api/integration/state", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "good-token")
        state = await api.async_get_state()

    assert state.version == "1.4.0"
    assert state.portals == []


async def test_get_state_raises_connection_error_on_malformed_json(aiohttp_server):
    async def handle(_request: web.Request) -> web.Response:
        return web.Response(text="{malformed", content_type="application/json")

    app = web.Application()
    app.router.add_get("/api/integration/state", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "good-token")
        with pytest.raises(PortalConnectionError):
            await api.async_get_state()


async def test_set_enabled_posts_to_the_portal_specific_route(portal):
    api, recorded = portal

    await api.async_set_enabled("p1", False)

    assert recorded[-1]["path"] == "/api/integration/portals/p1/enabled"
    assert recorded[-1]["portal_id"] == "p1"
    assert recorded[-1]["body"] == {"enabled": False}


async def test_set_enabled_raises_auth_error_on_401(aiohttp_server):
    async def handle(_request: web.Request) -> web.Response:
        return web.json_response({"error": "Unauthorized"}, status=401)

    app = web.Application()
    app.router.add_post("/api/integration/portals/{portal_id}/enabled", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "bad-token")
        with pytest.raises(PortalAuthError):
            await api.async_set_enabled("p1", True)
