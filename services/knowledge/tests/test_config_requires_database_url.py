"""AKM_DATABASE_URL must be required, not defaulted.

config.py carried:

    database_url: str = "postgresql://postgres:postgres@postgres:5432/hill90_akm"

Its host is already `postgres` and its database is already `hill90_akm`, so after the
cutover to the platform Postgres that default is correct EXCEPT for the credentials --
it fails only because role `postgres` does not exist there. That is the same family as
the auth.hill90.com/realms/hill90 issuer fallback: a default that is wrong today,
becomes nearly right later, and turns a missing variable into a puzzle rather than an
error.
"""
import os
import pytest


def _fresh_settings():
    # Settings reads the environment at construction, so import late.
    from app.config import Settings

    return Settings()


def test_missing_database_url_raises(monkeypatch):
    # AKM_INTERNAL_SERVICE_TOKEN is required by a pre-existing model validator. It is
    # set here so the ONLY thing missing is database_url — otherwise this test would
    # pass because of the token, which is passing for the wrong reason.
    monkeypatch.setenv("AKM_INTERNAL_SERVICE_TOKEN", "t")
    monkeypatch.delenv("AKM_DATABASE_URL", raising=False)
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as exc:
        _fresh_settings()

    # Assert on the STRUCTURED error, not the rendered message. An earlier version
    # asserted "internal_service_token" was absent from the text, which fails because
    # pydantic echoes the whole input dict — including the token's NAME — into the
    # message. The structured errors say precisely which field is missing.
    errors = exc.value.errors()
    assert len(errors) == 1, errors
    assert errors[0]["loc"] == ("database_url",), errors
    assert errors[0]["type"] == "missing", errors


def test_database_url_is_taken_from_the_environment(monkeypatch):
    monkeypatch.setenv("AKM_INTERNAL_SERVICE_TOKEN", "t")
    monkeypatch.setenv(
        "AKM_DATABASE_URL", "postgresql://hill90_app:pw@postgres:5432/hill90_akm"
    )
    s = _fresh_settings()
    assert s.database_url == "postgresql://hill90_app:pw@postgres:5432/hill90_akm"


def test_database_url_has_no_default_in_the_source():
    """Structural: no default may be assigned to database_url.

    An earlier version of this test asserted the string "postgresql://" never appears
    in the module, which failed against the COMMENT explaining the removal. The
    property is about the assignment, not about the text.
    """
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = open(os.path.join(here, "app", "config.py")).read()
    code = [
        line for line in src.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assignments = [line for line in code if line.strip().startswith("database_url")]
    assert assignments, "database_url must still be declared"
    for line in assignments:
        assert "=" not in line, f"database_url must have no default: {line.strip()}"
