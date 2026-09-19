"""Shared fixtures for the Guest Portal integration tests."""

import pytest


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Load custom_components/ in every test.

    Without this, Home Assistant's test harness refuses to see the
    integration and every config-flow test fails with 'Integration not found'.
    """
    yield
