"""Minimal stub — Task 17 implements the full config flow."""

from __future__ import annotations

from homeassistant import config_entries

from .const import DOMAIN


class GuestPortalConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Stub config flow — Task 17 replaces this."""

    VERSION = 1
