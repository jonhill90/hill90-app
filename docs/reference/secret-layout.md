# Secret layout

What each secret this application needs is for, and how the vault KV paths are
arranged.

Read alongside [`infra/secrets/prod.enc.env.example`](../../infra/secrets/prod.enc.env.example),
which lists the keys.

## The application's own secrets

- `DB_USER` / `DB_PASSWORD` / `DB_NAME`
- `JWT_SECRET`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` — the API signs agent tokens with
  these
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- `KC_ADMIN_USERNAME` / `KC_ADMIN_PASSWORD`
- `AUTH_SECRET`, `AUTH_KEYCLOAK_ID`, `AUTH_KEYCLOAK_SECRET`
- `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`

Two are referenced by services but were never in `.env.example`, having been injected
from the vault: `DISCORD_BOT_TOKEN` and `TAVILY_API_KEY` (web search).

## `AUTH_KEYCLOAK_ISSUER` and `AUTH_URL` are computed, not stored

They are **not store keys**, and the reason is worth keeping because the failure mode is
silent. They were removed once it was established that nothing read them: the compose
files compose the issuer from `APP_AUTH_HOST`, `BASE_DOMAIN` and `KC_REALM`, so editing
`AUTH_KEYCLOAK_ISSUER` in the store **changed nothing and warned about nothing**.

The knobs are `APP_AUTH_HOST` and `KC_REALM`. The variable still exists as an environment
variable the UI reads; it is simply derived rather than stored. Anyone debugging an issuer
mismatch by editing the store will get no error and no effect.

## The vault KV path layout, and two couplings visible only here

`platform/vault/policies/policy-{api,ai,ui,mcp,knowledge}.hcl` document the KV path
layout each service expects — the part `.env.example` cannot tell you. In summary: shared
material at `secret/data/shared/{database,jwt,model-router}`, per-service material at
`secret/data/<service>/*`.

**Two couplings are not visible from either the service code or the key list:**

- the **API** also reads `secret/data/knowledge/*`
- the **AI service** reads `secret/data/shared/model-router` in order to verify
  token-revocation requests coming from the API

Both were added after the extraction audit. A policy change that tightens either path
breaks a caller that does not obviously depend on it.

## Local development does not use any of this

`scripts/local.sh` generates everything into `.env.local` on first run: random shared
service tokens, and two fresh Ed25519 keypairs whose public halves are mounted at
`/etc/akm`. Nothing depends on the original key material, which is correct — tokens
signed by the old keys are worthless.
