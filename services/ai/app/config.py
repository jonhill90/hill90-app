"""AI service configuration via Pydantic settings."""

from functools import lru_cache
from pathlib import Path

from pydantic import ValidationError
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """AI service settings — loaded from environment variables."""

    # LiteLLM proxy
    litellm_url: str = "http://litellm:4000"
    litellm_master_key: str = ""

    # Database (shared hill90_api DB for policy/usage tables).
    #
    # REQUIRED, with no default, deliberately. It used to be `= ""`, and main.py
    # treated the empty case as a warning and served anyway — a process reporting
    # healthy while the database holding its policy and usage tables was absent. That
    # is the shape that hid the last three faults in this estate, so it fails closed.
    database_url: str

    # Ed25519 public key for JWT verification
    public_key_path: str = "/etc/akm/public.pem"

    # Internal service token for /internal/* endpoints
    model_router_internal_service_token: str = ""

    # app#548. /internal/embeddings has no agent JWT and so no per-caller
    # policy to check against — whose budget this spend should bill to is
    # a real, undecided design question (see the issue). This is NOT that
    # decision: it is a coarse, service-wide ceiling on the endpoint as a
    # whole, so "no spend without a check" is true today regardless of how
    # attribution is eventually resolved. Generous by design — the goal is
    # catching a runaway caller, not metering a legitimate one; the one
    # known legitimate caller is services/knowledge's ingest/search/memory
    # traffic, none of which should approach these numbers in practice.
    internal_embeddings_max_rpm: int = 300
    internal_embeddings_max_tokens_per_day: int = 5_000_000

    # AES-256-GCM key for decrypting user provider API keys (BYOK)
    provider_key_encryption_key: str = ""

    # API service URL for delegation token signing (service-to-service)
    api_service_url: str = "http://api:3000"

    # Service metadata
    environment: str = "production"
    port: int = 8000

    model_config = {"env_prefix": "", "case_sensitive": False}


@lru_cache
def get_settings() -> Settings:
    """Build Settings, turning a missing variable into an operator-readable failure.

    Pydantic's own error is correct and structured — `database_url`, `type: missing` —
    but it says the FIELD name in lowercase and cannot know which service it belongs
    to. What an operator actually sees is a container that exited, and eight services
    share thirty variables between them. So the message names the variable in the case
    they set it in, and names the service.
    """
    try:
        return Settings()
    except ValidationError as e:
        missing = [
            ".".join(str(p) for p in err["loc"])
            for err in e.errors()
            if err["type"] == "missing"
        ]
        if missing:
            names = ", ".join(m.upper() for m in missing)
            raise RuntimeError(
                f"app-ai cannot start: required environment variable(s) not set: "
                f"{names}. app-ai serves the model router and needs DATABASE_URL for "
                f"its policy and usage tables; it will not start without one rather "
                f"than report healthy while unable to read them."
            ) from e
        raise


def load_public_key(path: str | None = None) -> bytes:
    """Load Ed25519 public key PEM from disk."""
    key_path = Path(path or get_settings().public_key_path)
    if not key_path.exists():
        raise FileNotFoundError(f"Public key not found: {key_path}")
    return key_path.read_bytes()
