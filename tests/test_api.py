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
    "portalId": "11111111-1111-1111-1111-111111111111",
    "enabled": True,
    "haStale": False,
    "deviceCount": 3,
    "version": "1.0.0",
    "lastInteraction": {
        "ts": 1700000000000,
        "kind": "action",
        "entityId": "lock.front",
        "label": "Front Door",
        "action": "unlock",
        "ok": True,
    },
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
        recorded.append({"path": request.path, "body": body})
        if request.headers.get("Authorization") != "Bearer good-token":
            return web.json_response({"error": "Unauthorized"}, status=401)
        return web.json_response({"enabled": body["enabled"]})

    app = web.Application()
    app.router.add_get("/api/integration/state", handle_state)
    app.router.add_post("/api/integration/enabled", handle_enabled)

    server = await aiohttp_server(app)

    async with ClientSession() as session:
        yield PortalApi(session, "127.0.0.1", server.port, "good-token"), recorded


async def test_get_state_parses_the_payload(portal):
    api, _ = portal

    state = await api.async_get_state()

    assert state.portal_id == "11111111-1111-1111-1111-111111111111"
    assert state.enabled is True
    assert state.device_count == 3
    assert state.version == "1.0.0"
    assert state.last_interaction is not None
    assert state.last_interaction.entity_id == "lock.front"
    assert state.last_interaction.kind == "action"


async def test_get_state_sends_the_bearer_token(portal):
    api, recorded = portal

    await api.async_get_state()

    assert recorded[0]["auth"] == "Bearer good-token"


async def test_get_state_handles_a_null_interaction(aiohttp_server):
    async def handle(_request: web.Request) -> web.Response:
        return web.json_response({**STATE, "lastInteraction": None})

    app = web.Application()
    app.router.add_get("/api/integration/state", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "good-token")
        state = await api.async_get_state()

    assert state.last_interaction is None


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


async def test_set_enabled_posts_the_value(portal):
    api, recorded = portal

    await api.async_set_enabled(False)

    assert recorded[-1]["body"] == {"enabled": False}


async def test_set_enabled_raises_auth_error_on_401(aiohttp_server):
    async def handle(_request: web.Request) -> web.Response:
        return web.json_response({"error": "Unauthorized"}, status=401)

    app = web.Application()
    app.router.add_post("/api/integration/enabled", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "bad-token")
        with pytest.raises(PortalAuthError):
            await api.async_set_enabled(True)
