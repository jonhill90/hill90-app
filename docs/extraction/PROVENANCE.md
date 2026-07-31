# Provenance

How this repository was produced, what came across, and what did not.

## Source

| | |
|---|---|
| Repository | `github.com/jonhill90/Hill90` |
| Branch | `main` |
| Commit | `f03f12d2b6d05499e2cfff4592b12daf5b2f8705` |
| Source size | 858 commits, 800 tracked files, 6.76 MiB packfile |
| Extraction date | 2026-07-26 |
| Tool | `git-filter-repo` `a40bce548d2c`, git 2.49.0 |

## Result

| | |
|---|---|
| Commits | **542** of 858 |
| Files at `HEAD` | **669** of 800 |
| Packfile | 5.77 MiB |
| Oldest commit | 2026-01-11 — `feat: Complete Hill90 VPS project scaffold` |
| Newest inherited commit | 2026-07-25 — `chore: remove AI agent harness scaffolding (#492)` |

Verification output: [VERIFICATION.md](VERIFICATION.md).
Old-SHA → new-SHA mapping for all 858 source commits:
[commit-map.txt](commit-map.txt).
The exact path manifest passed to `filter-repo`: [app-paths.txt](app-paths.txt).

The command was:

```bash
git clone --no-local --single-branch --branch main file:///path/to/Hill90 hill90-app
cd hill90-app
git filter-repo --paths-from-file app-paths.txt --prune-empty always
```

`--no-local` prevents object hardlinking back to the source. `--force` was never
passed. `filter-repo` was never run inside the source repository, which was
asserted byte-identical (`HEAD` and `git status --porcelain`) before and after.

## What came across

The eight application services, the app-specific `platform/` configuration, the
app compose files, the app database provisioners, the Playwright suites, the
Mintlify docs site, and the app-specific architecture and runbook documents. Full
list in [app-paths.txt](app-paths.txt).

**Two of them have never been in an automated deploy**, which is worth knowing before
someone assumes a compose file implies a deploy path:

- `services/cli` — terminal client. No compose file, no Dockerfile wiring, no CI.
- `services/discord-bot` — has `deploy/compose/prod/docker-compose.discord-bot.yml` but
  was never added to the deploy dispatcher or any workflow, and needs
  `DISCORD_BOT_TOKEN`.

Both are real code and were extracted deliberately. Neither is broken; neither is
deployed. (Relocated here 2026-07-31 from a status document that expired around it.)

Two documents are copies rather than moves — Hill90 keeps its own:
`docs/architecture/overview.md` (the only whole-system diagram) and
`docs/decisions/infra-app-separation.md` (the record of why this split exists).

### Deliberate additions beyond the agreed baseline

`platform/data/postgres/`, `docker-compose.{auth,db,minio}.yml`,
`.env.example`, and `packages/common` were added on the evidence below, on the
principle that over-preserving is the safe error:

- The baseline took `platform/auth/keycloak/` but not the two files that make it
  deployable — `docker-compose.auth.yml` mounts the realm and theme and points
  Keycloak at its database; `platform/data/postgres/init.sh` creates that
  database.
- Postgres has no infrastructure consumer in Hill90: Grafana uses default SQLite,
  Loki uses `storage: filesystem`, Tempo uses `backend: local`, OpenBao uses
  `storage "file"`. `postgres-exporter` monitors it, which is not a dependency.
  `init.sh` creates only app databases.
- MinIO likewise: Loki and Tempo use local filesystem backends. Its only
  consumers are `services/api/src/services/s3.ts`,
  `services/knowledge/app/services/web_page_fetcher.py`, and
  `services/ui/src/utils/admin-services.ts`.

**Extracting these did not authorize Hill90 to delete them.** In particular,
Keycloak has a second consumer on the infrastructure side: `scripts/vault.sh
cmd_setup_oidc` configures OpenBao UI SSO via the `hill90-vault` client in this
realm. That was relayed to the Hill90 strip lane as its own decision.

## What did not come across, and why

| Excluded | Reason |
|---|---|
| `services/dns-manager` | **Infrastructure despite its path.** A Flask DNS-01 ACME webhook that translates Traefik's Lego `httpreq` calls to the Hostinger DNS API. Built by `docker-compose.infra.yml`; running on the live VPS. A blanket `--path services/` would have been wrong |
| `infra/` | Ansible, SOPS-encrypted secrets, systemd units, DNS automation |
| `platform/edge/` | Traefik static and dynamic configuration |
| `platform/observability/` | LGTM stack. Its Prometheus config scrapes **zero** application services — decisively infrastructure |
| `platform/vault/` | OpenBao. The mechanism is infra; the 8 app-shaped policies would be re-authored on resurrection, not extracted |
| `.github/` | The app's CI was entangled in a mixed `ci.yml` alongside shellcheck, bats, compose validation, and secrets-schema checks. A fresh minimal workflow was authored instead |
| `tests/scripts/`, `tests/checks/` | bats suites for the infra shell scripts; `test_deploy_scope.py` validates `deploy.yml` |
| `scripts/*.sh` except the two DB provisioners | `vps`, `hostinger`, `secrets`, `vault`, `backup`, `rollback`, `ops`, `validate`, `deploy`, `_common` |
| `scripts/checks/` | Infra guards |
| `Makefile`, `policy.hujson` | ~70% infra, and Tailscale ACL |
| `docker-compose.{infra,observability,vault}.yml` | Infra stacks |
| Infra docs | `docs/reference/*`, most of `docs/runbooks/*`, `docs/architecture/certificates.md` |

Everything above remains in Hill90.

## Reconciliation audit against Hill90's removal list

The extraction manifest and the Hill90 strip lane's removal list were written
independently. After the extraction was verified, the two were reconciled so that
nothing Hill90 deletes would survive only in its git history where nobody would
think to look. The comparison used the strip lane's documented removal set
(`SPEC.md` §1 verdicts plus §3 Steps 1–2) against the 669 extracted files.

| Set | Count | |
|---|---|---|
| Clean matches — deleted there, preserved here | 666 | as intended |
| Preserved here, kept there | 15 | shared docs and this repo's own new files; expected |
| **Deleted there, not preserved here** | **19** | assessed individually below |

Of the 19, six were real gaps and were added in a follow-up commit
(`platform/vault/policies/policy-{api,ai,ui,mcp,knowledge}.hcl` and
`.github/workflows/smoke-auth.yml`) — copied byte-identical from
Hill90@`f03f12d`, though as a plain commit rather than with history: re-running
`filter-repo` for six files would have rewritten every SHA and invalidated the
verification above.

The remaining thirteen are genuinely disposable:

- **Eight per-service deploy workflows** (`deploy-{api,ai,ui,mcp,knowledge,db,auth,minio}.yml`)
  — 15-line `workflow_dispatch` shims that pass a service name to
  `reusable-deploy-service.yml`, which stays in Hill90. Inert without it, and they
  carry no information beyond "there was a deploy button per service."
- **Four infra-stack vault policies** (`policy-{db,minio,auth,oidc-admin}.hcl`) —
  these describe AppRoles for the Postgres, MinIO, Keycloak, and OpenBao-SSO
  stacks rather than for any application service. `policy-oidc-admin.hcl` in
  particular is the OpenBao UI SSO binding, which is infrastructure by definition.
- **`scripts/checks/check_legacy_agentbox.sh`** — a CI gate asserting Hill90 never
  reintroduces the pre-#113 compose-managed agentbox deploy path. Every path it
  guards (`scripts/deploy.sh`, `Makefile`, `.github/workflows/deploy.yml`,
  `CONTRIBUTING.md`) is a Hill90 path that does not exist here.

The audit also re-checked every path cited in `RESURRECTION.md` (since removed — see the
note at the end of this document) against the
extracted tree and corrected two factual errors in it: the count of Traefik
routing labels (31 → 37) and the external-network list (two → three, with
`hill90_agent_internal` added and the self-provided `hill90_agent_sandbox` /
`hill90_docker_proxy` distinguished).

## History: what is preserved, and the honest caveats

History was preserved rather than squashed. The verdict rests on V4 in
[VERIFICATION.md](VERIFICATION.md), which shows `git log --follow` traversing
the 2026 restructure into the pre-restructure paths and reaching the project's
first commit.

`filter-repo` does not follow renames, so both sides of every rename were listed
in the manifest. The renames in this repo's lifetime:

| Rename | Commit (Hill90 SHA) |
|---|---|
| `deployments/` → `deploy/` | `cb4acf7` (#10) |
| `src/services/*` → `services/*`, `src/libs/common` → `packages/common` | `f0fcbec` (#124), commit 367 of 858 |
| `docs-site/` → `docs/site/` | `32fef4f` (#130) |

The restructure commit preserved 137 renames, detected at R100 (identical
content) across the boundary.

Caveats, stated plainly:

1. **316 of 858 commits do not appear.** They touched only infrastructure. This
   repo's history is the application's history, not the whole project's.
2. **~72 surviving commits over-describe their own diffs.** They touched both app
   and infra files; only the app side survives. A message like "add Discord
   management UI + fix health/detailed proxy" may show only half its changes.
   Nothing is lost — the other half is in Hill90 — but a commit message can
   promise more than its diff delivers.
3. **Every SHA changed.** `commit-map.txt` is the only bridge back to Hill90.
4. **CI and deploy history did not come across.** The app's CI evolution remains
   readable in Hill90's `ci.yml` history.
5. **`main` only.** Hill90's 118 unmerged local branches and 200+ remote branches
   are squash-merge residue; their content is already on `main`.
6. **Two retired monolithic compose files carry historical infrastructure
   content** — `deploy/compose/prod/docker-compose.yml` and
   `deployments/compose/prod/docker-compose.yml`, which predate the per-service
   split. They were included to preserve the app compose lineage and do not exist
   at `HEAD`.

## Note: RESURRECTION.md was removed on 2026-07-31

The extraction shipped a `RESURRECTION.md` — a checklist of what was broken and what had
to change. Its items were resolved, and what remained was a status tracker: "here is what
is still broken tonight" lists, container counts, and notes written to a future self
mid-crisis. That texture is what a stranger would have read first, so it was removed.

Three parts were **not** spent, and were relocated rather than deleted:

| Was | Now |
|---|---|
| §3, the app's secret layout and the two vault KV couplings | [`docs/reference/secret-layout.md`](../reference/secret-layout.md) |
| §6, the two services never wired into an automated deploy | this document, under [What came across](#what-came-across) |
| §7, the `fast-xml-parser` pin being load-bearing for storage | [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — the `TARGETARCH` half was already documented in `services/knowledge/Dockerfile` |

**The rule applied, and worth applying next time: decision records preserve, status
trackers expire.** A record explaining *why* something was decided or rebuilt stays, even
where its language has aged — `docs/decisions/infra-app-separation.md` still says "the AI
agent application is shelved", which is a statement of what was decided at the time and
is correct as such. A tracker describing *what state things were in* does not survive its
own timestamp.

Nothing was unpublished by this. Every removed line remains in `git log`.

## Related

- `PRD.md` and `SPEC.md` at the repository root — the plan this extraction
  executed, written before it ran.
- `docs/decisions/infra-app-separation.md` — the original decision.
