"""app-ai must refuse to start without its database, and say which variable is missing.

THE DEFECT, read from the code rather than taken from a summary.

config.py carried:

    database_url: str = ""

and main.py's lifespan did:

    if settings.database_url:
        try:
            _db_pool = await asyncpg.create_pool(...)
        except Exception as e:
            logger.error("db_connection_failed", error=str(e))
    else:
        logger.warning("database_url_not_set")

So the service started, reported healthy, and served requests with `_db_pool` set to
None. Policy and usage tables live in that database. This is the shape that hid the last
three faults in this estate: a process that is up while the thing it needs is absent.

TWO PATHS, not one. The brief named the missing variable. Reading it showed the
`except Exception` branch is the same defect wearing different clothes: with the
variable PRESENT but the database unreachable, it logs an error at level ERROR and
serves anyway. "Configured but broken" produces exactly the same healthy-and-useless
process as "not configured". Both are covered here.

The message must name the VARIABLE and the SERVICE, because the failure a human sees is
a container exiting and the only thing that helps is knowing which of eight services
wanted which of thirty variables.
"""

from __future__ import annotations

import os

import pytest
from pydantic import ValidationError


def _fresh_settings():
    """Settings reads the environment at construction, so import late.

    get_settings() is lru_cache'd, which would otherwise hand back an instance built
    before monkeypatch touched the environment.
    """
    from app.config import Settings, get_settings

    get_settings.cache_clear()
    return Settings()


def test_missing_database_url_raises(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)

    with pytest.raises(ValidationError) as exc:
        _fresh_settings()

    # Assert on the STRUCTURED error rather than the rendered text. Pydantic echoes the
    # whole input dict into its message, so a substring check can pass because some
    # other field happens to be named in it.
    errors = exc.value.errors()
    assert len(errors) == 1, f"database_url must be the only thing missing: {errors}"
    assert errors[0]["loc"] == ("database_url",), errors
    assert errors[0]["type"] == "missing", errors


def test_database_url_is_taken_from_the_environment(monkeypatch):
    monkeypatch.setenv(
        "DATABASE_URL", "postgresql://hill90_app:pw@postgres:5432/hill90_api"
    )
    s = _fresh_settings()
    assert s.database_url == "postgresql://hill90_app:pw@postgres:5432/hill90_api"


def test_database_url_has_no_default_in_the_source():
    """Structural: no default may be assigned.

    Asserting on the assignment rather than on whether "postgresql://" appears in the
    file, because the comment explaining the removal legitimately contains that string.
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


def test_the_error_names_the_variable_and_the_service(monkeypatch):
    """A ValidationError that says 'field required' helps nobody at 3am.

    The operator sees a container exit. What they need is which variable and which
    service, and neither is obvious from eight services sharing thirty variables.

    Asserted on get_settings(), not on Settings(). Pydantic's own message says
    `database_url` — the FIELD name, lowercase — and cannot know the service name.
    Those are two different contracts: the structured error above is for programs,
    this rendered message is for the human reading a crashed container's last line.
    get_settings() is the single seam main.py goes through, so it is where the
    operator-facing message belongs.
    """
    monkeypatch.delenv("DATABASE_URL", raising=False)

    from app.config import get_settings

    get_settings.cache_clear()

    with pytest.raises(Exception) as exc:
        get_settings()

    rendered = str(exc.value)
    assert "DATABASE_URL" in rendered, (
        f"the message must name the variable as the OPERATOR sets it, in the case "
        f"they set it in: {rendered}"
    )
    assert "app-ai" in rendered, f"the message must name the service: {rendered}"


def test_startup_refuses_when_the_database_is_unreachable(monkeypatch):
    """The second path: configured, but the database cannot be reached.

    Previously this logged db_connection_failed at ERROR and served on, which produces
    the same healthy-but-useless process as a missing variable. Startup must fail.
    """
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@nonexistent-host:5432/db")

    import asyncio

    import asyncpg
    from fastapi import FastAPI

    from app.config import get_settings
    from app.main import lifespan

    get_settings.cache_clear()

    async def refuse(*_a, **_kw):
        raise OSError("could not connect to nonexistent-host")

    monkeypatch.setattr(asyncpg, "create_pool", refuse)

    async def run() -> None:
        async with lifespan(FastAPI()):
            pass

    with pytest.raises(Exception) as exc:
        asyncio.run(run())

    # Not swallowed, and it must still say what failed.
    assert "nonexistent-host" in str(exc.value) or "DATABASE_URL" in str(exc.value), (
        f"the startup failure must name the cause: {exc.value!r}"
    )
