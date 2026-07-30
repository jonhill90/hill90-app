"""Test environment for the MCP gateway.

KEYCLOAK_ISSUER has no default in app/main.py, deliberately: a default would let a
misconfigured service look healthy, and one pointing at the retired `hill90` realm is
how a stale fallback becomes silently correct. Production sets it from compose; tests
set it here, before any test module imports the app.
"""
import os

os.environ.setdefault(
    "KEYCLOAK_ISSUER", "https://auth.hill90.com/realms/platform"
)
