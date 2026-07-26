# Resurrection checklist

Everything known to be broken or missing, with file paths, as of the extraction
on 2026-07-26. Nothing here was fixed — the app is shelved, and this list exists
so the diagnosis does not have to be redone from scratch.

Nothing in this repo has been started or health-checked since the VPS rebuild in
June 2026. Treat every item below as "known broken"; treat everything *not* below
as "unverified", not "working".

---

## 1. The dev stack cannot build as written

`deploy/compose/dev/docker-compose.yml` builds four services, one of which does
not exist:

```
line 18  context: ../../../services/api    ok
line 38  context: ../../../services/ai     ok
line 55  context: ../../../services/auth   ← this directory does not exist
line 79  context: ../../../services/ui     ok
```

`services/auth` was removed long before extraction; authentication moved to
Keycloak. The dev compose was never updated. It also predates
`services/knowledge`, `services/mcp`, and `services/agentbox` entirely, so even
with the `auth` block deleted it brings up a fraction of the system.

**To fix:** delete the `auth` service block, add `knowledge`/`mcp`/`agentbox`, and
check that each `Dockerfile.dev` referenced still exists.

## 2. There is no deployment path

The infrastructure stayed in Hill90. `deploy/compose/prod/*.yml` is preserved as
a specification, not as something runnable. What it assumes but does not provide:

- **Three external Docker networks** — `hill90_edge`, `hill90_internal`, and
  `hill90_agent_internal`, all declared `external: true`. All three were created
  by `docker-compose.infra.yml`, which stayed in Hill90. Nothing here creates
  them.
  Two further networks, `hill90_agent_sandbox` and `hill90_docker_proxy`, *are*
  self-provided — `docker-compose.api.yml` declares them for real, and `ai` and
  `knowledge` then reference `agent_sandbox` as external. So the api stack must
  come up before those two.
- **Traefik** — 37 `traefik.*` routing labels across the app compose files
  (`api`, `ai`, `auth`, `mcp`, `ui`, `minio`). Without Traefik, nothing is
  reachable and no TLS is issued.
- **`services/dns-manager`** — deliberately not extracted; it is the DNS-01 ACME
  webhook and remains in Hill90 as infrastructure. Certificates for
  Tailscale-only hostnames depended on it.
- **The deploy tooling** — `scripts/deploy.sh`, the `Makefile` targets, and the
  per-service GitHub Actions deploy workflows all stayed in Hill90.

**To fix:** either bring up a minimal edge (any reverse proxy plus the three
external networks) or rewrite the compose files for a single-host, no-proxy
layout.

## 3. Secrets have no source

Runtime secrets came from OpenBao with a SOPS-encrypted fallback
(`infra/secrets/prod.enc.env`). Neither comes with the app; both are infra.

The only surviving description of what the app needs is
`deploy/compose/prod/.env.example`, which after extraction lists the app-side
variables (a follow-up commit removed the infra-only ones — see the git log for
that file to recover them if needed):

- `DB_USER` / `DB_PASSWORD` / `DB_NAME`
- `JWT_SECRET`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` — the API signs agent tokens
  with these
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- `KC_ADMIN_USERNAME` / `KC_ADMIN_PASSWORD`
- `AUTH_SECRET`, `AUTH_KEYCLOAK_ID`, `AUTH_KEYCLOAK_SECRET`,
  `AUTH_KEYCLOAK_ISSUER`, `AUTH_URL`
- `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`

Two more are referenced by services but were never in `.env.example`, having been
injected from the vault: `DISCORD_BOT_TOKEN` and `TAVILY_API_KEY` (web search).

`platform/vault/policies/policy-{api,ai,ui,mcp,knowledge}.hcl` document the KV
path layout each service expected — which is the part `.env.example` cannot tell
you. In summary: shared material at `secret/data/shared/{database,jwt,model-router}`,
per-service material at `secret/data/<service>/*`. Two couplings are only visible
here: the API also reads `secret/data/knowledge/*`, and the AI service reads
`secret/data/shared/model-router` in order to verify token-revocation requests
coming from the API. These were added after the extraction audit — see
[docs/extraction/PROVENANCE.md](docs/extraction/PROVENANCE.md).

**To fix:** decide on a secrets mechanism, then regenerate the JWT keypair — the
old one is in a vault this repo cannot reach, and agent tokens signed by it are
worthless anyway.

## 4. The Keycloak realm is pinned to hill90.com

`platform/auth/keycloak/hill90-realm.json` hardcodes hostnames throughout:

```
https://hill90.com
https://hill90.com/api/auth/callback/keycloak
https://vault.hill90.com/ui/vault/auth/oidc/oidc/callback
https://vault.hill90.com/v1/auth/oidc/callback
```

Clients are `hill90-ui`, `hill90-api`, `hill90-vault`; realm roles are `user` and
`admin`; `loginTheme` is the custom `hill90` theme under
`platform/auth/keycloak/themes/`.

Two notes. The `hill90-vault` client and both `vault.hill90.com` redirect URIs
belong to **OpenBao UI SSO, which is infrastructure** — they are inert here and
can be deleted on resurrection. And `platform/auth/keycloak/setup-realm.sh`
hardcodes `CLIENT_ID="hill90-ui"` and `SEED_EMAIL="admin@hill90.com"`.

**To fix:** re-point every redirect URI and issuer at the new host, or regenerate
the realm and keep only the theme.

## 5. Database bootstrap is split across three places

- `platform/data/postgres/init.sh` — creates `keycloak`, `hill90_api`,
  `hill90_akm`, `hill90_litellm`. Runs as a Postgres entrypoint script, so it
  only fires on a fresh data volume.
- `scripts/provision-akm-db.sh`, `scripts/provision-litellm-db.sh` — provision
  those two databases against an already-running Postgres.
- Schema itself lives with the services: 65 migrations in
  `services/api/src/db/migrations/` and 12 in
  `services/knowledge/app/db/migrations/`, applied by the services at startup.

The prod compose expects `pgvector/pgvector:pg16`, not stock Postgres — the
knowledge service uses vector columns.

**To fix:** run `init.sh` against a fresh pgvector volume, then let the services
migrate themselves. Verify the migration runners still work; they have not been
exercised in over a year.

## 6. Services with no deployment wiring at all

- `services/cli` — terminal client, added in "feat: add Hill90 CLI for terminal-based
  agent interaction". No compose file, no Dockerfile wiring, no CI.
- `services/discord-bot` — has `deploy/compose/prod/docker-compose.discord-bot.yml`
  but was never added to the deploy dispatcher or any workflow, and needs
  `DISCORD_BOT_TOKEN`.

Both are real code and were extracted deliberately. Neither has ever been part of
an automated deploy.

## 7. Dependencies are a year stale

`services/api` and `services/ui` carry lockfiles from mid-2026. Two of the last
commits before the shelf were dependency-vulnerability fixes
(`services/api/package.json` bumps, `fast-xml-parser` pinned to `~5.6.0` to fix
S3 XML parsing). Python services pin `python = "^3.12"` via Poetry.

**To fix:** expect a substantial dependency bump, and re-pin `fast-xml-parser`
deliberately rather than letting it float — that pin was load-bearing for storage.

## 8. CI is gated off and unverified

`.github/workflows/ci.yml` runs unit tests only and is `workflow_dispatch`-only.
It has never been run. It is a starting point, not a passing build.

The original Hill90 CI also enforced two things this repo no longer checks:

- **OpenAPI drift** — `services/api/src/openapi/openapi.yaml` was diffed against
  `docs/site/openapi.yaml` on every PR. Both files came across; the check did not.
  They may already have drifted.
- **Redocly lint** of the OpenAPI spec.

`.github/workflows/smoke-auth.yml` is the original Playwright runner for
`tests/e2e/`, kept verbatim as the record of how those 12 specs were actually
invoked (Node 22, `npx playwright install --with-deps chromium`, working
directory `tests/e2e`). It ran against the live deployment, so it cannot pass
here; its `repository_dispatch: deploy-auth-success` trigger fires from a Hill90
workflow that no longer reaches this repo.

## 9. Things deliberately left behind

Not broken — absent by design. Recorded here so their absence is not mistaken for
loss. `services/dns-manager`, `infra/`, `platform/edge/`,
`platform/observability/`, `platform/vault/` (except the five app AppRole
policies, see §3), the infra shell scripts, the `Makefile`, and the per-service
deploy workflows all remain in
[jonhill90/Hill90](https://github.com/jonhill90/Hill90). See
[docs/extraction/PROVENANCE.md](docs/extraction/PROVENANCE.md) for the full
exclusion list, the reason for each, and the reconciliation audit against
Hill90's removal list.
