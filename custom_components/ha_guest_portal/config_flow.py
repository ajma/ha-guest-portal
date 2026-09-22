"""Config flow for the Home Assistant Guest Portal integration."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .api import PortalApi, PortalAuthError, PortalConnectionError, portal_version_too_old
from .const import CONF_TOKEN, DEFAULT_PORT, DOMAIN

_LOGGER = logging.getLogger(__name__)

USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST): str,
        vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
        vol.Required(CONF_TOKEN): str,
    }
)

REAUTH_SCHEMA = vol.Schema({vol.Required(CONF_TOKEN): str})


class GuestPortalConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for the Guest Portal."""

    VERSION = 1

    def __init__(self) -> None:
        """Hold discovery details between the discovery and confirm steps."""
        self._discovered: dict[str, Any] | None = None
        self._error: str = "cannot_connect"

    async def _async_probe(self, host: str, port: int, token: str) -> str | None:
        """Return the deployment id, or None if the portal could not be reached.

        Sets self._error to the string key the form should display.
        """
        api = PortalApi(async_get_clientsession(self.hass), host, port, token)

        try:
            state = await api.async_get_state()
        except PortalAuthError:
            self._error = "invalid_auth"
            return None
        except PortalConnectionError:
            self._error = "cannot_connect"
            return None

        if portal_version_too_old(state.version):
            # An add-on this old reports no deployment id at all, so there is
            # nothing to key an entry on. Say why rather than inventing one.
            self._error = "portal_too_old"
            return None

        return state.deployment_id

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Handle a manually initiated setup."""
        errors: dict[str, str] = {}

        if user_input is not None:
            self._error = "cannot_connect"
            deployment_id = await self._async_probe(
                user_input[CONF_HOST], user_input[CONF_PORT], user_input[CONF_TOKEN]
            )

            if deployment_id is not None:
                # The deployment's own id, so a manual entry and a discovered one
                # collapse to the same config entry rather than duplicating.
                await self.async_set_unique_id(deployment_id)
                self._abort_if_unique_id_configured()

                return self.async_create_entry(
                    title="Guest Portal",
                    data=user_input,
                )

            errors["base"] = self._error

        return self.async_show_form(step_id="user", data_schema=USER_SCHEMA, errors=errors)

    async def async_step_hassio(self, discovery_info: HassioServiceInfo) -> ConfigFlowResult:
        """Handle discovery from the Supervisor."""
        config = discovery_info.config

        # The add-on's discovery payload calls this key "portalId", but what it
        # carries is the deployment's id -- the same value /api/integration/state
        # reports as deploymentId, and the same one the user flow keys on.
        deployment_id = config.get("portalId")
        host = config.get("host")
        port = config.get("port")
        token = config.get("token")

        if deployment_id is None or host is None or port is None or token is None:
            return self.async_abort(reason="cannot_connect")

        await self.async_set_unique_id(str(deployment_id))
        self._abort_if_unique_id_configured(
            updates={
                CONF_HOST: host,
                CONF_PORT: port,
                CONF_TOKEN: token,
            }
        )

        self._discovered = {
            CONF_HOST: host,
            CONF_PORT: port,
            CONF_TOKEN: token,
        }

        self.context["title_placeholders"] = {"name": discovery_info.name}

        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask the user to confirm a discovered portal."""
        assert self._discovered is not None

        if user_input is None:
            return self.async_show_form(step_id="hassio_confirm")

        return self.async_create_entry(title="Guest Portal", data=self._discovered)

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """Handle a rejected token."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Prompt for a fresh token."""
        errors: dict[str, str] = {}
        entry = self._get_reauth_entry()

        if user_input is not None:
            self._error = "cannot_connect"
            deployment_id = await self._async_probe(
                entry.data[CONF_HOST], entry.data[CONF_PORT], user_input[CONF_TOKEN]
            )

            if deployment_id is not None:
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_TOKEN: user_input[CONF_TOKEN]}
                )

            errors["base"] = self._error

        return self.async_show_form(
            step_id="reauth_confirm", data_schema=REAUTH_SCHEMA, errors=errors
        )
