# Verification

Actual command output from the extraction run. Every gate below was executed
against the raw filtered repository **before** any new files were added, so V2's
file count reflects the extraction alone.

- **Source:** `github.com/jonhill90/Hill90` @ `f03f12d2b6d05499e2cfff4592b12daf5b2f8705` (858 commits, 800 files)
- **Date:** 2026-07-26
- **Tool:** `git-filter-repo a40bce548d2c`, git 2.49.0
- **Result:** 542 commits, 669 files

| Gate | What it proves | Result |
|---|---|---|
| V1 | Content-addressed equality against the source | **PASS** |
| V2 | File manifest is exactly right, no more, no fewer | **PASS** |
| V3 | Commit count reconciles with source per-path history | **PASS** |
| V4 | History is continuous across the `src/services/` rename | **PASS** |
| V5 | Zero excluded paths anywhere in history | **PASS** |
| V6 | No credentials anywhere in rewritten history | **PASS** |
| V7 | Object-count and size sanity | **PASS** |
| V8 | This document | **PASS** |

A note on reproducing these: the commands are bash. Under zsh an unquoted `$var`
holding multiple paths does not word-split, so `git log -- $PATHS` silently
matches nothing and reports zero — a failure mode that looks like a real result.

---

## Source integrity assertion

`git filter-repo` is destructive to the repository it runs in. It was run only in
a scratch clone made with `--no-local` (no object hardlinking back to the
source), `--force` was never passed, and the source was asserted unchanged
before and after.

```
=== STEP 4: source integrity assertion ===
HEAD before: f03f12d2b6d05499e2cfff4592b12daf5b2f8705
HEAD now:    f03f12d2b6d05499e2cfff4592b12daf5b2f8705
OK: HEAD unchanged
OK: working tree byte-identical
commits still: 858
```

---

## V1 — content equality

Git object IDs are content-addressed: identical hashes mean bit-identical
contents, recursively. This is a proof rather than a sample. Fully-kept subtrees
are compared as trees; partially-kept directories are compared per file, since
their parent tree hash legitimately differs.

```
=== V1a — fully-kept subtree hash equality (source f03f12d2b6d05499e2cfff4592b12daf5b2f8705) ===
OK    services/api                     dfff25d24b67453f09ca81941474e2b7947d6867
OK    services/ai                      297ddfb879dca5b0f19d39237d382fe2ca1ecff7
OK    services/ui                      4f0402b69aa7c22d37fb417b7ed2025b06223ed3
OK    services/mcp                     745ee6348467ba60d2e48876e8e6fa2c588c9b42
OK    services/knowledge               f7d08e6defba03e1657928c6a367dc0fb953d2dd
OK    services/agentbox                5502c53ecc4c01dea57a70fe6333e60171fb2801
OK    services/cli                     56af02887aa40c43a624ab0f114a45262263da7c
OK    services/discord-bot             337149ac48535c7119182d072ebe32ce808634c9
OK    packages/common                  f422d7a62c565d242faba151938c82a1d4968df4
OK    platform/ai                      c9cc7897597992dcff42c96b26a762051c6399e9
OK    platform/auth/keycloak           235baca569513026bf4c736532044617b8035535
OK    platform/data/postgres           c017025b2e115d9c204738eeae9cda44225d73b9
OK    deploy/compose/dev               a8ba70690a5a7c05ad0e0ad6e6534750191b26ba
OK    tests/e2e                        5898492c49062ec60ae6c11c70f2c5b28c073f09
OK    docs/site                        9644ddcc011bcea0ddc9d015d1dc7c2fc1e76217

=== V1b — per-file blob equality in partially-kept dirs ===
OK    deploy/compose/prod/docker-compose.api.yml                 93edbdb20cf12e9046efaa152a1ba24a6ff2f52a
OK    deploy/compose/prod/docker-compose.ai.yml                  54b541145aa828325dbb00e87d0c3d624514d939
OK    deploy/compose/prod/docker-compose.ui.yml                  47f2c5844c497edf0c8cdfeef9840306e03c0e55
OK    deploy/compose/prod/docker-compose.mcp.yml                 b08dea008208d4fc6367deaedfb2e9f81f209a17
OK    deploy/compose/prod/docker-compose.knowledge.yml           fb5a66a8769ef2e12b8bd781d4554d90d72ccbd0
OK    deploy/compose/prod/docker-compose.agentbox-images.yml     28db8cbd3d828e47bfe22c21161d40f83d4ac207
OK    deploy/compose/prod/docker-compose.discord-bot.yml         0faea023da70d037fa13b2ff6328b460985ea195
OK    deploy/compose/prod/docker-compose.auth.yml                845dcc485e0dfa4abcc0e90c384dd9f1223b3d33
OK    deploy/compose/prod/docker-compose.db.yml                  ed833e2509204ba179933c1aafbf3335231a5a97
OK    deploy/compose/prod/docker-compose.minio.yml               d9e780bbadb8c2736eaccc9f98323e0488389b65
OK    deploy/compose/prod/.env.example                           efac337c72991948db6b2664e4c9fdc71eff8d7b
OK    scripts/provision-akm-db.sh                                58a545d519ddc6c1011c525d49c04d6d87f3cff4
OK    scripts/provision-litellm-db.sh                            eb5de8683f088a2e7dd509e730f05a9241437022
OK    docs/architecture/agent-harness.md                         99db6c1b24e068d411159acbd444d094d26e9f3b
OK    docs/architecture/agent-identity-model.md                  dbc2fb59a61be1b7d0296b2f44df9f94a9b0141a
OK    docs/architecture/agent-progression-system.md              eeaa2529b5c0a9512e576c0c7a67d990db347e8d
OK    docs/architecture/task-board.md                            c0aa69c056d12ab82ae521f7d7f0a9cfe0645bdd
OK    docs/architecture/terminal-streaming-protocol.md           4936b10dbfae56e0d3f1e36e202860a0cc6cc416
OK    docs/architecture/memory-model-boundaries.md               c2918a02342e4c2eeea6a3ccbdeec8554ed2ba37
OK    docs/architecture/mcp-gateway-evaluation.md                5876d5f76952101de78dec51376e97d0801a154d
OK    docs/architecture/secrets-vault-ui-design.md               fdd6e13b274294306075495df0a5b094e1d70faa
OK    docs/architecture/ui-components.md                         7f4201f3522d7ac4c1ee6ba2449b5d39583e1ed4
OK    docs/architecture/trust-boundaries.md                      906f7bc27ee6e9dc0078319d1d337467bb1f6a1f
OK    docs/architecture/overview.md                              6f0c48dffdce064f9bc5c9f07f94c4341e30040b
OK    docs/runbooks/agent-file-ops-verification.md               75e6cde92bd354cd30a4fbb647258b8fdabfde8a
OK    docs/runbooks/api-auth-verification.md                     32ba56c67a02d52e2d5dad95d5102898feacf5c3
OK    docs/runbooks/keycloak-auth-ops.md                         f7d4114df58a02699ae644e2fcdb3a3aba0e7154
OK    docs/development/local-setup.md                            85b538fb796dd95aa51b77efa3b0ad63f36cfe29
OK    docs/decisions/infra-app-separation.md                     8f506ed29f7672087706fe71396f80e5c7790d35

V1 PASS
```

---

## V2 and V3 — manifest and commit reconciliation

```
=== V2 — file manifest equality ===
V2 PASS — 669 files, diff empty

=== V3 — commit reconciliation ===
source commits touching manifest: 542
result commits:                   542
V3 PASS — exact match
```

`diff` between the source's file list under the manifest and the result's
complete file list was empty. Commit counts matched exactly, with no divergence
from `--prune-empty`.

---

## V4 — rename continuity

The gate that separates preserved history from a truncated snapshot. If the
manifest had omitted the pre-restructure paths, history would stop dead at
`f0fcbec` (2026, commit 367 of 858) and the repo would appear to begin there.

```
=== V4 — rename continuity ===
--- git log --follow services/ui/package.json (oldest 6) ---
b1ab563 refactor: restructure to ops-first monorepo layout (#124)
0ca4bf2 feat: add admin-only Swagger UI docs page to UI service (#114)
953a6ab feat: wire Keycloak login end-to-end (UI, API, MCP) (#74)
12749ed feat: Auth.js + JWT validation middleware for API and MCP (#53)
3015a0f feat: add UI frontend with landing page and health dashboard (#17)
ea71b28 feat: Complete Hill90 VPS project scaffold

--- commits touching the pre-restructure path src/services ---
count: 64
--- oldest 5 commits in the whole repo ---
ea71b28 feat: Complete Hill90 VPS project scaffold
12b2c3f feat: Add package-lock.json files for Node.js services
02acf76 fix: Correct Docker build context paths in prod compose file
4de6f95 fix: Install all dependencies in Dockerfile build stage for TypeScript compilation
b150bc5 fix: Use system user/group to avoid uid/gid conflicts in Alpine
--- date range ---
first: 2026-01-11 23:28:24 -0500 feat: Complete Hill90 VPS project scaffold
last:  2026-07-25 22:55:10 -0400 chore: remove AI agent harness scaffolding (

--- the restructure commit, mapped f0fcbec -> new SHA ---
new sha: b1ab5639c939bae6f2cdb4933ee0e3b1a53f189b
b1ab563 refactor: restructure to ops-first monorepo layout (#124)

 deploy/compose/dev/docker-compose.yml                   |  16 ++++++++--------
 deploy/compose/prod/docker-compose.ai.yml               |   2 +-
renames preserved in that commit: 137

--- rename detection across the boundary ---
R100	src/services/ui/package.json	services/ui/package.json
```

`--follow` reaches `feat: Complete Hill90 VPS project scaffold` (2026-01-11), the
project's first substantive commit. 64 commits touch the pre-restructure
`src/services` path. The restructure commit preserved 137 renames, and the
boundary crossing is detected at `R100` — identical content, not a
heuristic guess.

---

## V5 — exclusion audit over all history

Checks every commit, not just `HEAD`. A path that existed only historically would
still be a leak.

```
=== V5 — exclusion audit over ALL history ===
distinct paths ever present in rewritten history: 852
--- searching for excluded paths ---
V5 PASS — zero excluded paths anywhere in history

--- top-level entries ever seen (sanity) ---
deploy deployments docs docs-site packages platform scripts services src tests 
```

---

## V6 — secret scan

```
=== V6 — secret scan ===
--- secret-shaped paths anywhere in history ---
services/ui/src/app/api/admin/secrets/kv/route.ts
services/ui/src/app/api/admin/secrets/route.ts
services/ui/src/app/api/admin/secrets/status/route.ts
services/ui/src/app/harness/secrets/page.tsx
services/ui/src/app/harness/secrets/SecretsClient.tsx

--- env/compose files present at HEAD, checked for literal values ---
REVIEW deploy/compose/dev/.env.example
5:DB_PASSWORD=devpassword
REVIEW deploy/compose/prod/.env.example
6:VERSION=latest
10:DB_PASSWORD=REPLACE_WITH_SECURE_PASSWORD
14:JWT_SECRET=REPLACE_WITH_RANDOM_SECRET
15:JWT_PRIVATE_KEY=REPLACE_WITH_RSA_PRIVATE_KEY
16:JWT_PUBLIC_KEY=REPLACE_WITH_RSA_PUBLIC_KEY
(no REVIEW lines = no literal-looking secrets in env/compose at HEAD)

--- high-entropy / known-token patterns across ALL blobs in history ---
blobs scanned: 2163
credential-pattern hits: 0
V6 PASS
```

The `secrets/` path hits are UI source files for the app's secrets-management
page, not secrets. The flagged assignments are placeholders (`REPLACE_WITH_*`),
a local-dev password, and `VERSION=latest`. `infra/` was excluded wholesale, so
the SOPS-encrypted `prod.enc.env` could not cross over. 2163 blobs across all
history were scanned for private-key headers and provider token formats
(`sk-`, `ghp_`, `xoxb-`, `AKIA`, `tskey-`): zero hits.

---

## V7 — size sanity

```
=== V7 — size sanity ===
--- source (Hill90) ---
count: 5145
in-pack: 8741
size-pack: 6.76 MiB
files: 800  commits: 858
--- result (hill90-app) ---
count: 0
in-pack: 7068
size-pack: 5.77 MiB
files: 669  commits: 542

ratio files:   669/800 = 84%
ratio commits: 542/858 = 63%
V7 PASS — proportionate to an 84%-of-files subset; filter applied and did not over-apply
```

---

## V8 — this document

Recorded in-repo alongside [PROVENANCE.md](PROVENANCE.md),
[app-paths.txt](app-paths.txt), and [commit-map.txt](commit-map.txt). V1 and V3
can be re-run against Hill90 by a cold reader and must produce the same answer.
