from typing import Callable
from fastapi import HTTPException, Request


def make_verify_token(
    issuer: str,
    get_signing_key: Callable[[dict], str],
    audience: str,
):
    """Factory that returns a FastAPI dependency for JWT validation.

    Args:
        issuer: Expected token issuer (iss claim).
        get_signing_key: Callable accepting the decoded token header dict
            and returning the PEM-encoded public key.
        audience: Expected audience (aud claim). Required, not optional —
            app#485: without it, any token issued by the realm authenticates
            here, one minted for hill90-ui, grafana, portainer, or any other
            client Keycloak issues for. A caller who can log in to any client
            in the realm could present that token to this service. No
            default is offered for the same reason KEYCLOAK_ISSUER has none
            in app/main.py: a silent fallback is how this gap comes back.
    """
    from jose import jwt as jose_jwt, JWTError

    async def verify_token(request: Request) -> dict:
        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

        token = auth_header[7:]

        try:
            header = jose_jwt.get_unverified_header(token)
            key = get_signing_key(header)
            payload = jose_jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                issuer=issuer,
                audience=audience,
                # require_aud, not just verify_aud: python-jose treats the aud
                # claim as OPTIONAL per spec text and silently skips the check
                # when it is absent entirely — verify_aud alone does not catch
                # a token minted with no audience at all. Confirmed against a
                # real admin-cli-issued token, which carries no aud claim.
                options={"verify_aud": True, "require_aud": True, "require_exp": True},
            )
        except (JWTError, ValueError, KeyError):
            raise HTTPException(status_code=401, detail="Invalid or expired token")

        return payload

    return verify_token
