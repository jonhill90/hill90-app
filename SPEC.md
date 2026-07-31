# hill90-app — Extraction Specification

Implements `PRD.md`. Nothing here has been executed.

**Source:** `/Users/jon/source/repos/Personal/Hill90`, branch `main`, at planning
time `f03f12d` — 858 commits, 800 tracked files, 6.76 MiB packfile, 6 merge
commits (squash-merge workflow, effectively linear).

**Target:** `github.com/jonhill90/hill90-app` (private, empty, default branch
`main`) and the local checkout at `/Users/jon/source/repos/Personal/hill90-app`.

**Tooling:** `git-filter-repo` at `/opt/homebrew/bin/git-filter-repo`
(`a40bce548d2c`), git 2.49.0.

---

## 1. The single biggest risk, and how it is avoided

`git filter-repo` is destructive to the repository it runs in. It must never run
inside `/Users/jon/source/repos/Personal/Hill90`. Four independent guards:

1. **All work happens in a scratch clone** under the session scratchpad. Jon's
   checkout is never the working directory of a write command.
2. **`git clone --no-local`.** Without it, a same-filesystem clone hardlinks
   object files back to the source. `--no-local` forces the git transport, so the
   scratch clone's objects are physically separate copies. This is the guard that
   matters most.
3. **`--force` is never passed.** `filter-repo` refuses to run on a repo that is
   not a fresh clone. That refusal is a safety feature; suppressing it defeats the
   design.
4. **Pre/post assertion on the source.** `HEAD` and `git status --porcelain` are
   captured before the run and compared after. Any difference is a stop-the-line
   event.

Additionally: nothing in this lane deletes from Hill90, ever, under any branch of
the procedure including rollback. Tagging and doc updates on the Hill90 side are
specified in §8 and executed by the strip lane or by Jon.

### Shell note

Commands below are **bash**. Under zsh, an unquoted `$var` containing spaces does
not word-split, so `git log -- $PATHS` silently matches nothing and reports zero
— a failure mode that looks like a real result. Run verification through
`bash -c` or `mapfile` as shown, never by pasting a path variable into zsh.

---

## 2. Manifest

Written to `extract/app-paths.txt`. `filter-repo` treats each line as a literal
path (a directory keeps its whole subtree); `#` comments and blank lines are
ignored. Every entry below was validated against the source: current paths with
`git ls-files --error-unmatch`, historical paths with `git log --oneline -- <path>`.

### 2a. Baseline — from the strip lane's inventory

```
# --- application services (dns-manager deliberately absent, see §4) ---
services/api
services/ai
services/ui
services/mcp
services/knowledge
services/agentbox
services/cli
services/discord-bot

# --- app-specific platform config ---
platform/ai/litellm_config.yaml
platform/auth/keycloak

# --- app compose ---
deploy/compose/dev
deploy/compose/prod/docker-compose.api.yml
deploy/compose/prod/docker-compose.ai.yml
deploy/compose/prod/docker-compose.ui.yml
deploy/compose/prod/docker-compose.mcp.yml
deploy/compose/prod/docker-compose.knowledge.yml
deploy/compose/prod/docker-compose.agentbox-images.yml
deploy/compose/prod/docker-compose.discord-bot.yml

# --- app database provisioning ---
scripts/provision-akm-db.sh
scripts/provision-litellm-db.sh

# --- app tests ---
tests/e2e

# --- app docs ---
docs/site
docs/architecture/agent-harness.md
docs/architecture/agent-identity-model.md
docs/architecture/agent-progression-system.md
docs/architecture/task-board.md
docs/architecture/terminal-streaming-protocol.md
docs/architecture/memory-model-boundaries.md
docs/architecture/mcp-gateway-evaluation.md
docs/architecture/secrets-vault-ui-design.md
docs/architecture/ui-components.md
docs/architecture/trust-boundaries.md
docs/architecture/overview.md
docs/runbooks/agent-file-ops-verification.md
docs/runbooks/api-auth-verification.md
docs/runbooks/keycloak-auth-ops.md
docs/development/local-setup.md
docs/decisions/infra-app-separation.md
```

`docs/architecture/overview.md` and `docs/decisions/infra-app-separation.md` are
mixed/infra-classified, taken deliberately: the first is the only whole-system
diagram, the second is the provenance record. Both are *copies* — Hill90 keeps
its own.

### 2b. Addendum — proposed additions, flagged for relay

These are **not** in the answers doc's list. They are added on evidence gathered
here, on the principle that over-preserving is the safe error. Each is
individually droppable — deleting its line from `app-paths.txt` is the entire
change required.

```
platform/data/postgres
deploy/compose/prod/docker-compose.auth.yml
deploy/compose/prod/docker-compose.db.yml
deploy/compose/prod/docker-compose.minio.yml
deploy/compose/prod/.env.example
packages/common
```

Justification:

- The baseline takes `platform/auth/keycloak/` but not the two files that make it
  deployable. `docker-compose.auth.yml` is what mounts the realm and the `hill90`
  theme and points Keycloak at `jdbc:postgresql://postgres:5432/keycloak`;
  `platform/data/postgres/init.sh` is what creates the `keycloak` database. A
  realm with no way to run it is not preservation.
- `platform/data/postgres/init.sh` creates exactly `keycloak`, `hill90_api`,
  `hill90_akm`, `hill90_litellm` — four app databases and nothing else.
- `.env.example` is the only surviving description of the app's required
  environment variables. It is ~60% app / 40% infra; extract whole, prune the
  infra keys in a separate follow-up commit so the pruning is reviewable.
- `packages/common` is dead scaffolding (a 2-line `__init__.py`, a one-line
  `index.ts`, no importers) but it is app-side and was `src/libs/common`.

**Relay, explicitly:** extracting these does **not** authorize Hill90 to delete
them. See §4 for the counter-dependency.

### 2c. Historical aliases — required for history continuity

`filter-repo` does not follow renames. Both sides of every rename must be listed
or history truncates at the rename. Verified rename events:

| Rename | Commit | Position |
|---|---|---|
| `deployments/` → `deploy/` | `cb4acf7` (#10) | early |
| `docs-site/` → `docs/site/` | `32fef4f` (#130) | mid |
| `src/services/*` → `services/*`, `src/libs/common` → `packages/common` | `f0fcbec` (#124) | commit 367 of 858 |

```
src/services/api
src/services/ai
src/services/ui
src/services/mcp
src/services/agentbox
src/libs/common
docs-site
deployments/compose/dev
deployments/compose/prod/.env.example
deployments/compose/prod/docker-compose.api.yml
deployments/compose/prod/docker-compose.ai.yml
deployments/compose/prod/docker-compose.mcp.yml
deployments/compose/prod/docker-compose.auth.yml
deployments/compose/prod/docker-compose.yml
deploy/compose/prod/docker-compose.agentbox.yml
deploy/compose/prod/docker-compose.yml
```

Two of these are retired monolithic compose files (`docker-compose.yml`, 21 and 2
commits respectively) that predate the per-service split and contain both app and
infra service definitions. They no longer exist at `HEAD`, so they cannot appear
in the extracted working tree — only in history, where they are the origin of the
app compose lineage. Included deliberately.

`services/knowledge`, `services/cli`, and `services/discord-bot` need no aliases:
all three were created after the restructure (`9b07a02` #135, `815e41a`,
`5943259`).

### 2d. Explicit exclusions

| Excluded | Reason |
|---|---|
| `services/dns-manager`, `src/services/dns-manager` | **Infrastructure.** Flask DNS-01 ACME webhook for Traefik; built by `deploy/compose/prod/docker-compose.infra.yml`; currently running on the live VPS. See §4. |
| `infra/` | Ansible, SOPS secrets, systemd, DNS — pure infra, and the only place encrypted secrets live |
| `platform/edge/`, `platform/observability/`, `platform/vault/` | Traefik, LGTM, OpenBao. The observability config scrapes **zero** app services — it is decisively infra |
| `.github/` | The app's CI is entangled in a mixed `ci.yml`; a fresh minimal workflow is authored instead (§5) |
| `tests/scripts/`, `tests/checks/` | bats tests for the infra shell scripts; `test_deploy_scope.py` validates `deploy.yml` |
| `scripts/*.sh` except the two provisioners | `vps`, `hostinger`, `secrets`, `vault`, `backup`, `rollback`, `ops`, `validate`, `deploy`, `_common` |
| `scripts/checks/` | Infra guards (secrets schema, volume names, destructive commands) |
| `Makefile`, `README.md`, `CONTRIBUTING.md`, `policy.hujson` | ~70% infra, or infra-only; replaced with app-scoped versions (§5) |
| `deployments/platform/` | Historical Traefik config |
| `docker-compose.{infra,observability,vault}.yml` | Infra stacks |
| infra-only docs | `docs/reference/*`, `docs/runbooks/{bootstrap,deployment,disaster-recovery,observability,troubleshooting,vault-unseal,secrets-*}.md`, `docs/architecture/certificates.md` |

### 2e. Expected result

Measured against the source at `f03f12d`:

| Metric | Value |
|---|---|
| Manifest entries | 60 |
| Commits surviving | **542** of 858 |
| Tracked files at `HEAD` | **669** of 800 |
| Surviving commits that also touched excluded paths | ~72 |

Record the actual numbers at run time; they will differ if `main` advances again.

---

## 3. The four ambiguous components

The brief flags Postgres, MinIO, Keycloak, and OpenBao as genuinely ambiguous.
Evidence gathered from the source tree:

| Component | Evidence | Handling |
|---|---|---|
| **Postgres** | Grafana uses default SQLite (`GF_*` env only, `grafana-data:/var/lib/grafana`); Loki uses `storage: filesystem`; Tempo uses `backend: local`; OpenBao uses `storage "file"`. **No infra service depends on it.** `postgres-exporter` monitors it, which is not a dependency. `init.sh` creates only app databases. | **Moves with the app** (addendum 2b) |
| **MinIO** | Loki and Tempo both use local filesystem backends, not S3. Sole consumers are `services/api/src/services/s3.ts`, `services/knowledge/app/services/web_page_fetcher.py`, `services/ui/src/utils/admin-services.ts`. | **Moves with the app** (addendum 2b) |
| **Keycloak** | Realm is entirely app-shaped: clients `hill90-ui`/`hill90-api`, `loginTheme: hill90`, redirect to `https://hill90.com/api/auth/callback/keycloak`. Grafana, Traefik, and Portainer do **not** use it. **But** `scripts/vault.sh cmd_setup_oidc` gives OpenBao UI SSO via the `hill90-vault` client. | **Moves with the app**, with the vault-OIDC dependency relayed to the strip lane (§7) |
| **OpenBao** | Self-contained (file storage). Consumed by `scripts/vault.sh`, `deploy.sh`, `vault-sync-to-sops.yml`, `infra/systemd/`, `infra/ansible/`. But 8 of 13 policies describe app-service secret paths. | **Stays infra.** The mechanism is infra; the app-shaped policies would be re-authored on resurrection, not extracted |

**If the strip lane's inventory resolves any of these differently**, only §2b
changes — one line per component in `app-paths.txt`. The baseline (§2a), the
mechanism (§5), and the verification (§6) are unaffected. This is the whole reason
the addendum is a separate block.

---

## 4. `services/dns-manager` — the boundary correction

A blanket `git filter-repo --path services/` would be **wrong**. `services/dns-manager`
is a Flask DNS-01 ACME webhook that translates Traefik's Lego `httpreq` calls into
Hostinger DNS API calls, issuing certificates for Tailscale-only services. It is
built by `deploy/compose/prod/docker-compose.infra.yml` and is one of the
containers running on the live VPS right now. Both sibling lanes reached this
independently.

Consequences, both of which this spec encodes:

1. The manifest enumerates the eight app services individually rather than taking
   `services/` wholesale. `services/dns-manager` and `src/services/dns-manager`
   (6 commits, pre-restructure) are absent.
2. **Relay to the strip lane:** do not delete `services/dns-manager` from Hill90.
   It is live infrastructure that happens to be filed under `services/`.

---

## 5. Mechanism

### Step 0 — capture source state (read-only)

```bash
SRC=/Users/jon/source/repos/Personal/Hill90
WORK="$SCRATCH/extract"                 # session scratchpad, not /tmp
mkdir -p "$WORK"

git -C "$SRC" rev-parse HEAD            > "$WORK/SOURCE_SHA"
git -C "$SRC" rev-parse --abbrev-ref HEAD > "$WORK/SOURCE_BRANCH"
git -C "$SRC" status --porcelain        > "$WORK/SOURCE_STATUS_BEFORE"
git -C "$SRC" rev-list --count HEAD     > "$WORK/SOURCE_COMMITS"
```

`SOURCE_BRANCH` must read `main`. If it does not, stop — the source checkout is
not where this spec assumes it is.

### Step 1 — scratch clone

```bash
git clone --no-local --single-branch --branch main \
    "file://$SRC" "$WORK/hill90-app"
```

`--no-local` is mandatory (§1). `--single-branch` drops the 118 unmerged local
branches and all remotes; they are squash-merged content already present on
`main`.

### Step 2 — write the manifest

`app-paths.txt` = §2a + §2b + §2c concatenated, comments stripped or left in
place (`filter-repo` ignores `#` lines).

### Step 3 — filter

```bash
cd "$WORK/hill90-app"
test "$(git rev-parse --show-toplevel)" = "$WORK/hill90-app" || exit 1   # guard
git filter-repo --paths-from-file "$WORK/app-paths.txt" --prune-empty always
```

No `--force`. No `--path-rename` — paths are preserved exactly as they are in
Hill90, which is what makes the §6 hash comparison a direct proof rather than an
approximation.

`filter-repo` leaves `.git/filter-repo/commit-map` (old SHA → new SHA for all 858
source commits). Copy it out immediately — it is the only bridge back to Hill90's
history and it is easy to lose:

```bash
cp .git/filter-repo/commit-map "$WORK/commit-map.txt"
```

### Step 4 — assert the source is untouched

```bash
diff <(git -C "$SRC" status --porcelain) "$WORK/SOURCE_STATUS_BEFORE"
test "$(git -C "$SRC" rev-parse HEAD)" = "$(cat "$WORK/SOURCE_SHA")"
```

Any difference: stop, report, do not continue.

### Step 5 — verify

Run §6 gates V1–V7 against the **raw filtered repo**, before adding any new files.
V2 in particular is only meaningful before the tree is modified.

### Step 6 — add the standalone layer

New commits on top of the preserved history:

| File | Content |
|---|---|
| `README.md` | First paragraph: *shelved — not verified runnable since June 2026.* Then: what the app is, the service table, where it came from (`Hill90@<SOURCE_SHA>`), and a pointer to `RESURRECTION.md` |
| `RESURRECTION.md` | Every known-broken thing with file path and required change — seeded from `PRD.md` "End state". **Removed 2026-07-31** once its items were resolved; the durable parts moved to `docs/reference/secret-layout.md`, `docs/extraction/PROVENANCE.md` and `CONTRIBUTING.md` |
| `.gitignore` | App subset of Hill90's: `node_modules/`, `.next/`, `next-env.d.ts`, `*.tsbuildinfo`, `dist/`, Python/`.ruff_cache`, `.playwright-*`, `tests/e2e/{test-results,playwright-report}/`. Terraform/Ansible/SOPS rules dropped |
| `.editorconfig` | Copied verbatim; it is generic |
| `CONTRIBUTING.md` | Rewritten: branch naming and commit format kept; the deploy rule, command map, and vault/secrets workflow dropped — none of that tooling comes here |
| `docs/extraction/PROVENANCE.md` | Source SHA, date, manifest, exclusions with reasons, and the history caveats from §9 |
| `docs/extraction/VERIFICATION.md` | §6 output, pasted |
| `docs/extraction/commit-map.txt` | From step 3 |
| `.github/workflows/ci.yml` | `on: workflow_dispatch` **only**. Jobs: `services/api` npm test, `services/ui` vitest, `services/mcp` + `services/agentbox` pytest. Present and one click away; never fires unbidden on an archived repo |

Then, as a separate reviewable commit: prune the infra keys from
`deploy/compose/prod/.env.example` (§2b).

### Step 7 — publish

```bash
cd "$WORK/hill90-app"
git remote add origin https://github.com/jonhill90/hill90-app.git
git push -u origin main
```

Then materialise Jon's checkout — the target directory is currently empty:

```bash
git clone https://github.com/jonhill90/hill90-app.git \
    /Users/jon/source/repos/Personal/hill90-app
```

(`PRD.md` and `SPEC.md` currently live in that empty directory. Move them into
the scratch clone before pushing so they are part of the repo, then clone over
the emptied directory.)

---

## 6. Verification

Eight gates. Each must produce output pasted into
`docs/extraction/VERIFICATION.md`. A gate without its output is not passed.

### V1 — content equality (the load-bearing one)

Git object IDs are content-addressed: if two trees hash the same, their contents
are bit-identical, recursively. This is a proof, not a sample.

For every **fully kept** subtree — `services/{api,ai,ui,mcp,knowledge,agentbox,cli,discord-bot}`,
`packages/common`, `platform/ai`, `platform/auth/keycloak`, `platform/data/postgres`,
`deploy/compose/dev`, `tests/e2e`, `docs/site`:

```bash
bash -c '
SRC=/Users/jon/source/repos/Personal/Hill90; NEW="$WORK/hill90-app"
SHA=$(cat "$WORK/SOURCE_SHA"); fail=0
for p in services/api services/ai services/ui services/mcp services/knowledge \
         services/agentbox services/cli services/discord-bot packages/common \
         platform/ai platform/auth/keycloak platform/data/postgres \
         deploy/compose/dev tests/e2e docs/site; do
  a=$(git -C "$SRC" rev-parse "$SHA:$p")
  b=$(git -C "$NEW" rev-parse "HEAD:$p")
  [ "$a" = "$b" ] && echo "OK   $p  $a" || { echo "FAIL $p  $a != $b"; fail=1; }
done
exit $fail'
```

For **partially kept** directories (`deploy/compose/prod`, `docs/architecture`,
`docs/runbooks`, `docs/development`, `docs/decisions`, `scripts`) the parent tree
hash legitimately differs, so compare per-file blob hashes with the same
`rev-parse <sha>:<path>` form.

Note `platform/ai` is fully kept as a tree even though the manifest names
`platform/ai/litellm_config.yaml` — it is the directory's only tracked file.

### V2 — file manifest equality

Run on the raw filtered repo, **before** step 6 adds anything.

```bash
bash -c '
mapfile -t P < "$WORK/app-paths.txt"
git -C /Users/jon/source/repos/Personal/Hill90 ls-files -- "${P[@]}" | sort > "$WORK/expected.txt"
git -C "$WORK/hill90-app" ls-files | sort > "$WORK/actual.txt"
diff "$WORK/expected.txt" "$WORK/actual.txt" && echo "V2 OK: $(wc -l < "$WORK/actual.txt") files"'
```

Expected: 669 files, empty diff. Historical-only aliases contribute nothing at
`HEAD` and are correctly absent.

### V3 — commit reconciliation

```bash
bash -c '
mapfile -t P < "$WORK/app-paths.txt"
echo "source: $(git -C /Users/jon/source/repos/Personal/Hill90 log --oneline -- "${P[@]}" | wc -l)"
echo "result: $(git -C "$WORK/hill90-app" rev-list --count HEAD)"'
```

Expected: both 542. Small divergence is explainable (`--prune-empty` removing
commits whose only app change was a delete of an excluded sibling); a large one
is not — investigate before proceeding.

### V4 — rename continuity

The gate that distinguishes preserved history from a truncated snapshot.

```bash
cd "$WORK/hill90-app"
git log --oneline --follow -- services/ui/package.json | tail -5
git log --oneline -- src/services | wc -l
git show --stat f0fcbec 2>/dev/null | head    # SHA will have changed — use commit-map
```

Must show: `--follow` reaching commits from before the restructure; a non-zero
count of commits touching `src/services`; the earliest commit in the repo dating
to the project's start, not to 2026-07.

### V5 — exclusion audit over all history

```bash
cd "$WORK/hill90-app"
git log --all --name-only --format= | sort -u | grep -E \
  '^(infra/|services/dns-manager|src/services/dns-manager|platform/(edge|observability|vault)/|\.github/|tests/(scripts|checks)/|scripts/(vps|vault|secrets|backup|rollback|ops|validate|hostinger|deploy|_common)\.|Makefile|policy\.hujson)' \
  && echo "V5 FAIL" || echo "V5 OK"
```

Must print `V5 OK`. This checks every commit, not just `HEAD` — an excluded path
that existed only historically would still be a leak.

### V6 — secret scan

```bash
cd "$WORK/hill90-app"
git log --all --name-only --format= | sort -u | grep -E '\.enc\.env|\.key$|secrets/' || echo "no secret-shaped paths"
git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectname) %(rest)' \
  | awk '$1=="blob"' | wc -l
gitleaks detect --source . --no-banner || true    # if available
```

`infra/` is excluded wholesale, so the SOPS-encrypted `prod.enc.env` cannot cross
over — but `.env.example` files and compose files are extracted and must be read
for real values rather than `${VAR}` placeholders.

### V7 — size sanity

```bash
git -C "$WORK/hill90-app" count-objects -vH
```

Source packfile is 6.76 MiB across 800 files. A result dramatically larger means
the filter did not apply; dramatically smaller means it over-applied.

### V8 — record it

`docs/extraction/VERIFICATION.md` containing: the source SHA, the date, the
commands run, and their **actual pasted output**. A cold reader must be able to
re-run V1 and V3 against Hill90 and get the same answer.

---

## 7. Ordering constraint and cross-lane handshake

Hard sequence. The strip lane's plan already encodes the gate.

```
1. This lane: extract                              (§5 steps 0–4)
2. This lane: verify V1–V8 all pass                (§6)
3. This lane: publish to github.com/jonhill90/hill90-app
4. This lane: relay confirmation to Jon
5. ─────────────── GATE ───────────────
6. Strip lane: delete app paths from Hill90
7. Strip lane / Jon: tag and annotate Hill90       (§8)
```

Nothing is deleted from Hill90 before step 5. Deleting first risks a gap that
nothing would detect — the whole point of V1–V3 is that they compare against a
source that still has the files.

**The confirmation relayed at step 4 must state:** the source SHA extracted from;
the surviving commit count; the file count at `HEAD`; V1–V8 pass/fail each; and
the two relays below.

### Relay A — do not delete `services/dns-manager`

Live infrastructure filed under `services/`. See §4.

### Relay B — Keycloak has a second consumer

`scripts/vault.sh cmd_setup_oidc` configures OpenBao UI SSO against the
`hill90-vault` client in `platform/auth/keycloak/hill90-realm.json`
(`oidc_discovery_url=https://auth.hill90.com/realms/hill90`), with
`platform/vault/policies/policy-oidc-admin.hcl` mapping the realm `admin` role to
vault access. If Hill90 removes Keycloak, vault OIDC login breaks until it is
re-pointed or downgraded to token auth. Also dead-ends: the `keycloak` Prometheus
scrape job, the `keycloak.json` Grafana dashboard, and the only service exporting
traces to Tempo.

This lane extracting the realm does not resolve this. It is the strip lane's call.

---

## 8. Markers left behind in Hill90

Specified here, **executed by the strip lane or by Jon** — this lane does not
write to Hill90.

1. **Annotated tag on the pre-strip commit:**

   ```bash
   git tag -a archive/app-stack-final <PRE_STRIP_SHA> -m \
   "Final state of the Hill90 application stack before extraction.

   Extracted to https://github.com/jonhill90/hill90-app
   Extraction source SHA: <SOURCE_SHA>
   Surviving commits: <N>   Files: <M>
   See docs/decisions/infra-app-separation.md"
   git push origin archive/app-stack-final
   ```

   `<PRE_STRIP_SHA>` is `main` at the moment of stripping, resolved then — not
   copied from this document. The brief cites `1b9394c`; `main` has since advanced
   to `f03f12d` and may advance again.

2. **Pointer appended to `docs/decisions/infra-app-separation.md`**, whose Status
   is currently "decided, not implemented": record that the app half is
   implemented, name the target repo, the tag, and the date.

3. Optionally a short "Where the app went" note in Hill90's `README.md`, replacing
   the app rows in the services table.

---

## 9. History: what is preserved and what is not

**Verdict, as the answers doc asked for explicitly: take the preserved history.
The squash fallback is not needed.**

Renames do not fragment this history, because §2c lists both sides of each one.
`filter-repo` keeps the rename commits themselves, so `git log --follow`
traverses `services/api` → `src/services/api` without a break, and the repo's
earliest commits date to the project's start rather than to the 2026 restructure.
V4 is the gate that proves this rather than assuming it.

Honest costs, all to be recorded in `docs/extraction/PROVENANCE.md`:

1. **~316 of 858 commits do not appear.** They touched only infra. Correct, but
   the repo's history is not the whole project's history.
2. **~72 surviving commits over-describe their own diffs.** They touched both app
   and infra files; only the app side survives, so a message like "add Discord
   management UI + fix health/detailed proxy" may show only half its changes.
   Nothing is lost, but a commit message can promise more than its diff delivers.
3. **All SHAs change.** `filter-repo` rewrites every commit. `docs/extraction/commit-map.txt`
   is the bridge; without it, cross-referencing a Hill90 commit is impossible.
4. **CI and deploy history do not come across.** `.github/` is excluded because
   the app's CI is entangled in a mixed `ci.yml`. The app's CI evolution remains
   readable in Hill90.
5. **`main` only.** The 118 unmerged local branches and 200+ remote branches are
   squash-merge residue; their content is on `main`.
6. **Two retired monolithic compose files carry historical infra content** (§2c).
   They do not exist at `HEAD`.

None of these makes the history misleading. The condition that would have
triggered the squash fallback — renames fragmenting lineage so badly that the
result reads as a truncated snapshot — does not hold, and V4 is where that claim
gets tested rather than asserted. **If V4 fails at execution time, stop and report
before publishing**; do not ship a mangled history under the label "preserved."

---

## 10. Rollback

| Stage | Failure | Recovery |
|---|---|---|
| Before step 3 | anything | `rm -rf "$WORK"`. Blast radius zero |
| `filter-repo` errors or produces a wrong tree | manifest bug | `rm -rf "$WORK/hill90-app"`, fix `app-paths.txt`, re-clone from step 1. The filter is a pure function of source + manifest — it is cheap to redo, so **never** patch a bad filter result by hand |
| Any V-gate fails | manifest or mechanism bug | Do not push. Fix and re-run from step 1. §7's gate means Hill90 has lost nothing |
| After push, defect found | anything | `git push --force origin main` with the corrected history, or delete and recreate the GitHub repo. Nothing depends on it yet, and the strip lane has not run |
| Step 4 assertion fails (source modified) | **critical** | Stop everything. Do not push, do not proceed. Report to Jon with the diff. `git -C "$SRC" reflog` and `git fsck` are the recovery path, but Hill90's `origin/main` on GitHub is the real backstop |

Hill90 is never the target of a write in any row of this table. Its worst case is
that this lane produces nothing and is retried.
