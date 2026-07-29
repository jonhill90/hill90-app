# Resurrection checklist

What was broken when the application was extracted on 2026-07-26, and what has
been done about it. Originally a list of things to fix; now mostly a record of
fixes, kept because several of these were subtle and the reasoning is worth
having next time someone touches the compose or auth wiring.

**Status: the local stack runs, the test suites pass, and the app is deployed to
production as a Hill90 tenant.**
`./scripts/local.sh up` brings up nine healthy containers and a working login;
CI on `main` is green across all six jobs, 1953 tests, zero failures (§8).
Items 1–5 and 8 below are resolved; what remains open is called out as such.

A deployment path now exists and has been used — see item 2. Four of eight
stacks are deployed and healthy; `knowledge` and `ai` are not working and `mcp`
and `minio` have never been deployed.

---

## 1. The dev stack cannot build as written — FIXED

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

**Fixed.** `deploy/compose/dev/` is deleted. It was three services short of the
current architecture and could not build at all, so it was replaced rather than
repaired: `compose/local.yml` covers postgres, minio, keycloak, litellm, api, ai,
knowledge, mcp and ui. See [README](README.md#running-locally).

## 2. There is no deployment path — RESOLVED

This was open by design for most of the extraction's life. It is no longer true:
the app was deployed to the Hill90 VPS on 2026-07-29 from a GitHub Actions
workflow in this repository, and `hill90.com` serves the UI on a Let's Encrypt
certificate.

What was built here rather than inherited: `scripts/deploy.sh` and
`scripts/_common.sh`, a SOPS-encrypted store at `infra/secrets/prod.enc.env`, and
`.github/workflows/deploy.yml` ("Manual Deploy App (Prod)"). Deploys run over SSH
from the runner via Tailscale — never from a workstation — and the workflow is
`workflow_dispatch`-only with a `dry_run` mode that runs every guard and stops
before changing anything.

The app deploys as a **tenant**: it consumes `hill90_edge` and `hill90_internal`
as external networks that Hill90 creates, and parameterises names through
`NETWORK_PREFIX`, `VOLUME_PREFIX` and `CONTAINER_PREFIX` so one set of files
serves both environments. It is detachable in design only — **no yank-out test
has been run.**

Not everything is deployed. `ui`, `db`, `auth` and `api` are healthy;
`knowledge` is crash-looping with its fix merged but not deployed; `ai` is
unhealthy; `mcp` and `minio` have never been deployed.

The original analysis, kept because it is what the design answers — what
`deploy/compose/prod/*.yml` assumed but did not provide:

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
- **`services/dns-manager`** — deliberately not extracted; it was the DNS-01 ACME
  webhook, and certificates for Tailscale-only hostnames depended on it. **It no longer
  exists in Hill90 either.** DNS moved to Cloudflare on 2026-07-27 and the service was
  deleted; Traefik now solves DNS-01 with lego's built-in `cloudflare` provider. The
  capability survives as configuration, so this is no longer a missing dependency.
- **The deploy tooling** — `scripts/deploy.sh` and the per-service GitHub Actions
  deploy workflows stayed in Hill90. Both have since been rebuilt here, following
  Hill90's shape rather than inventing a second dialect. The `Makefile` targets
  were not; there is still no `Makefile` in this repo.

**Resolved.** `compose/local.yml` remains the standalone local path, creating its
own networks and publishing ports. `deploy/compose/prod/*.yml` is now the
deployed article rather than a specification, with `deploy/compose/overrides/`
layering local differences onto the same files instead of forking them.

## 3. Secrets have no source — FIXED for local

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

**Fixed for local.** `scripts/local.sh` generates everything into `.env.local`
on first run: random shared service tokens, and two fresh Ed25519 keypairs whose
public halves are mounted at `/etc/akm`. Nothing depends on the original key
material, which was correct — tokens signed by the old keys are worthless.
A deployed environment still needs a real secrets mechanism.

## 4. The Keycloak realm is pinned to hill90.com — FIXED for local

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

**Fixed for local** by deriving a second realm rather than editing the preserved
one. `compose/local/keycloak/realm-local.json` keeps the same clients and roles
but uses localhost redirect URIs, `sslRequired: none`, a fixed client secret, the
stock login theme, and a seeded `dev` / `dev` user holding both realm roles. The
`hill90-vault` client is dropped — it is OpenBao SSO, which is infrastructure.
`platform/auth/keycloak/hill90-realm.json` is untouched.

That exposed a third problem worth knowing about: **the browser and the UI
container reach Keycloak on different URLs**, so a single issuer value cannot
work. The browser needs `localhost:18080`; the UI container needs `keycloak:8080`.
Auth.js derives every endpoint from `issuer` via OIDC discovery, and discovery
against the browser-facing URL fails inside the container with a bare
`TypeError: fetch failed`.

`services/ui/src/auth.ts` now takes an optional `KEYCLOAK_INTERNAL_ISSUER`. When
set, the token, userinfo and JWKS endpoints are pinned to it and discovery is
skipped, while `issuer` and the authorization endpoint stay browser-facing so the
`iss` claim still matches what the API validates. Unset, behaviour is exactly as
before, so production wiring is unaffected. Keycloak is given `KC_HOSTNAME` and
`KC_HOSTNAME_BACKCHANNEL_DYNAMIC` so it stamps the same `iss` either way.

## 5. Database bootstrap is split across three places — FIXED

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

**Fixed, and the migration runners turned out to be broken.** The local stack
runs `platform/data/postgres/init.sh` as a pgvector entrypoint script and lets
each service migrate itself. Verifying that surfaced two real bugs, both fixed:

- `platform/data/postgres/init.sh` was mode `644` in git. The Postgres
  entrypoint tries to execute `.sh` files it considers executable, and macOS
  bind mounts report one — so it failed with `bad interpreter: Permission
  denied` and no databases were created. Now mode `755`.
- `services/api/src/db/migrations/046_seed_browser_tool_and_skill.sql` assigned
  `scope = EXCLUDED.scope` twice in one `ON CONFLICT DO UPDATE`, which Postgres
  rejects. Because the runner stops at the first failure, **19 of 65 migrations
  never applied** — including `056_create_workflows.sql`, which is why the
  workflow scheduler logged `relation "workflows" does not exist` on a loop.
  This migration could never have applied to a fresh database.

All 65 API migrations and all 12 knowledge migrations now apply cleanly.

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
Nothing has been bumped; all five images build and run as pinned.

One build bug was fixed in passing: `services/knowledge/Dockerfile` hardcoded
`GOARCH=amd64` when compiling the Go `akm` CLI, so on arm64 it produced a binary
that could not execute. It now uses BuildKit's `TARGETARCH`. The agentbox image
copies that binary out of the knowledge image, so the breakage reached agent
shells too.

## 8. CI is gated off — STILL GATED, and the suites PASS

`.github/workflows/ci.yml` runs unit tests only and is `workflow_dispatch`-only.
Deliberately manual. The original reason was that this repo had no deploy target;
now that it has one, the reason is stronger rather than weaker — a merge should
not deploy to production by itself. `deploy.yml` is dispatch-only for the same
reason.

**The tests pass.** Run on `main` at `e04aa6a` on 2026-07-26, all six jobs
green in 2m26s:

| Job | Result |
|---|---|
| `services/api` (jest) | 743 passed, 56 suites |
| `services/ui` (vitest) | 736 passed, 7 skipped, 63 files |
| `services/agentbox` (pytest) | 187 passed |
| `services/ai` (pytest) | 177 passed |
| `services/knowledge` (pytest) | 102 passed |
| `services/mcp` (pytest) | 8 passed |

**1953 tests, zero failures.** For a codebase shelved for a year that is a
better result than the state of this document would suggest, and it is worth
being explicit about what it does and does not mean:

- It covers unit tests only. Nothing here proves the services work *together* —
  that is what the local stack is for.
- `services/knowledge/tests/integration` (18 files) is excluded: it needs a live
  pgvector Postgres. Run it against the local stack.
- Getting here needed three fixes, none of them test logic:
  a migration that could never apply to a fresh database (§5), an `app.shell`
  global leaking between agentbox test files, and `package-mode = false` missing
  from `services/{ai,mcp}` so Poetry 2.x refused to install. Only the third was
  a CI-only problem.

Before this run the suites had never been executed on `main` — every earlier run
was a branch tip. Re-run after any dependency bump; that is where the next
failure will come from (§7).

The original Hill90 CI also enforced two things this repo no longer checks:

- **OpenAPI drift** — `services/api/src/openapi/openapi.yaml` was diffed against
  `docs/site/openapi.yaml` on every PR. The check did not come across, and `docs/site/`
  has since been deleted from this repo as a duplicate of the published pages. The
  published copy now lives in
  [hill90-docs](https://github.com/jonhill90/hill90-docs) as `ai-app/openapi.yaml`, so
  the drift risk is now cross-repo and nothing checks it.
- **Redocly lint** of the OpenAPI spec.

`.github/workflows/smoke-auth.yml` is the original Playwright runner for
`tests/e2e/`, kept verbatim as the record of how those 12 specs were actually
invoked (Node 22, `npx playwright install --with-deps chromium`, working
directory `tests/e2e`). It ran against the live deployment, so it cannot pass
here; its `repository_dispatch: deploy-auth-success` trigger fires from a Hill90
workflow that no longer reaches this repo.

## 9. Things deliberately left behind

Not broken — absent by design. Recorded here so their absence is not mistaken for
loss. `services/dns-manager` (since deleted from Hill90 too — see §2), `infra/`,
`platform/edge/`,
`platform/observability/`, `platform/vault/` (except the five app AppRole
policies, see §3), the infra shell scripts, the `Makefile`, and the per-service
deploy workflows all remain in
[jonhill90/Hill90](https://github.com/jonhill90/Hill90). See
[docs/extraction/PROVENANCE.md](docs/extraction/PROVENANCE.md) for the full
exclusion list, the reason for each, and the reconciliation audit against
Hill90's removal list.

## 10. The production realm ships with no users — OPEN

The two realm imports disagree about accounts, and only one of them is
reproducible:

| Import | Realm | Realm roles | Users |
|---|---|---|---|
| `compose/local/keycloak/realm-local.json` | `hill90` | `user`, `admin` | 1 — `dev` / `dev@localhost`, both roles |
| `platform/auth/keycloak/hill90-realm.json` | `hill90` | `user`, `admin` | **0** |

So a local stack has a working account the moment it starts, and production has
none. The realm imports cleanly and OIDC discovery answers, but nobody can sign
in until an operator creates an account by hand.

Two accounts were created that way on 2026-07-29 — `jon` and `hill90admin`, with
temporary passwords that must be changed at first login. **They exist only in
`app-postgres`.** They are not in any import, not in the SOPS store, and not in
any script. Rebuilding the app's database — `deploy.sh teardown db` keeps the
volume, but a volume loss or a deliberate reset does not — deletes both and locks
everyone out of production with no path back except direct Keycloak admin access.

This is recorded rather than fixed because the fix is a real decision, not a
typo: seeding an account into a committed realm import means deciding what
credential it carries and how that is rotated, and the local file's answer
(`dev` / `dev`) is not one production can copy.
