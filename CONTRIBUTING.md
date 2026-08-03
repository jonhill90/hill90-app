# Contributing to hill90-app

This repository deploys to production. There is no CI that runs on its own, and
no workflow fires on merge — deploys are dispatched by hand. Read [`CONTRIBUTING.md`](CONTRIBUTING.md#deploying) below for how the deploy path works,
and the README's status table for what is currently live.

What follows is the working convention this repository uses. Hill90's own deploy rules,
secrets workflow and VPS operations are still **not** reproduced here; this repo
grew its own, deliberately narrower, as a tenant rather than a platform owner.

## Deploying

`gh workflow run "Manual Deploy App (Prod)"`, `workflow_dispatch` only, inputs
`service` / `dry_run` / `confirm_public_deploy`. It runs over SSH from a GitHub
Actions runner on the tailnet. **Never deploy from a workstation** — there is no
supported path for it and the guards do not run there.

Use `dry_run=true` first. It exercises every guard — secrets present, tenancy
contract satisfied, host paths writable — and stops before touching the host.

## Issue tracking

Issues for this repository live in **its own GitHub Issues**. Work spanning more
than one repository is filed in [Hill90](https://github.com/jonhill90/Hill90) and
links out; see that repository's `CONTRIBUTING.md` for the routing table.

`AI-###` identifiers — and the `**Linear:** AI-114` headers on several documents
under `docs/` — refer to a Linear workspace that was retired as a tracker on
2026-07-26. **They are not GitHub issue numbers**: `AI-8` is a Linear identifier
and has nothing to do with this repository's #8, which is a real and separate
issue here.

The workspace was kept as a record rather than deleted. It held about 250 issues
across its two teams and all but two were already closed at the cutover, so only
those two moved to GitHub — `AI-258` is now
[#8](https://github.com/jonhill90/hill90-app/issues/8) here, and `JON-55` became
[Hill90#532](https://github.com/jonhill90/Hill90/issues/532). Every other
`AI-###` resolves only in Linear.

## Branch naming

| Type | Prefix |
|---|---|
| Feature | `feat/<description>` |
| Refactor | `refactor/<description>` |
| Bug fix | `fix/<description>` |
| Docs | `docs/<description>` |
| Enhancement | `enhance/<description>` |
| Chore | `chore/<description>` |

## Commit format

```text
<type>: <short description>

<body explaining why, not what>
```

## If you pick this up cold

- Update `services/api/src/openapi/openapi.yaml` when adding or changing API
  routes. Hill90's CI enforced spec-vs-route drift and also diffed that file against
  the published spec; neither check came across. The published copy now lives in
  [hill90-docs](https://github.com/jonhill90/hill90-docs) as `ai-app/openapi.yaml`, so
  the two may already disagree and nothing checks it.
- Tests live next to their services: `services/api` (jest), `services/ui`
  (vitest), `services/mcp` and `services/agentbox` (pytest). End-to-end
  Playwright suites are in `tests/e2e/` and require a running stack.
- Do not commit real secrets. `.env.example` files are tracked; `.env` is not.

## Dependency pins that are load-bearing

- **`services/api` → `fast-xml-parser` is pinned `~5.6.0` deliberately.** It was pinned
  to fix S3 XML parsing, so storage depends on it; a dependency bump that lets it float
  again will break object storage in a way that does not look like a dependency problem.
  Re-pin it consciously rather than accepting whatever a bump produces. (JSON takes no
  comments, which is why this note is here rather than beside the line.)
- `services/knowledge/Dockerfile` builds the Go `akm` binary with BuildKit's
  `TARGETARCH`. The reason it must not be hardcoded is documented in the Dockerfile
  itself.

## History

Commits before 2026-07-26 were rewritten by `git filter-repo` during extraction
and have different SHAs than their Hill90 originals.
[`docs/extraction/commit-map.txt`](docs/extraction/commit-map.txt) maps old to
new. Commits from before `refactor: restructure to ops-first monorepo layout
(#124)` reference paths under `src/services/`, which is where this code lived
until then.

## Read the Copilot review before merging — and verify it

Every PR here gets a GitHub Copilot code review (`dynamic/agents/copilot-pull-request-reviewer`).
It is not a repo workflow, so it does not appear in `.github/workflows`, and its check is
green whether or not anyone reads what it said.

**An unread review is indistinguishable from no review.** On 2026-08-03 it reviewed 8 PRs in
one session, left inline comments on 5, and was read on none of them. One of those comments
identified a CI service block wired to the wrong job — the same defect the author rediscovered
later by hand, after it had already been written down.

```
gh pr view <n> --json reviews
gh api repos/<owner>/<repo>/pulls/<n>/comments --jq '.[]|"\(.path):\(.line) \(.body)"'
```

**Verify what it says rather than acting on it.** In the same session its two comments split
one-for-one: the wrong-job finding was correct; a claim that `if: matrix.setup != ''` would
evaluate true for undefined values was not — the step demonstrably skips on the arms where
`setup` is unset. Both were stated with equal confidence. A review comment is a lead, and this
repository's standing rule applies to it exactly as to any other instrument: check it before
believing it.

## An instrument can be wrong in BOTH directions at once

The worst instrument failure is not over-reporting or under-reporting. It is doing both in the
same run, because the two hide each other.

Measured on 2026-08-03, auditing `services/api` for fire-and-forget promise chains. A grep for
un-awaited calls to async functions reported **three** sites:

- two were **false positives** — calls sitting on their own line inside an awaited
  `Promise.all`, which look identical to a floating call when you match line shapes;
- and it never opened `notifications.ts`, `webhook-dispatch.ts` or `workflow-scheduler.ts` at
  all, which between them hold **four** of the six real sites.

Wrong in both directions, simultaneously. **That combination is more dangerous than either
alone**: a reader who spot-checks one of the false positives concludes the tool over-reports,
discounts the output, and by doing so trusts the misses. The noise buys credibility for the
silence.

Re-run with `@typescript-eslint/no-floating-promises` against the real `tsconfig.json` — an
instrument that knows what returns a promise rather than what a line looks like — the answer was
six sites, correctly. Same question, same repository, ten minutes apart.

**The rule this adds to the three above:** when an instrument is shown to be wrong once, do not
patch that one result and carry on. Ask which direction the error was in, then check the other
direction explicitly, because an instrument that can invent a finding can equally well omit one,
and you will only notice the invention.

A corollary worth stating, from the same audit: **choosing the right rule matters as much as
choosing the right tool.** `no-misused-promises` reported 191 sites in the same run — every
`router.get('/x', async …)` in the service — all of them already safe because of the vendored
middleware in `src/boot/async-errors.ts`. Reporting 197 would have counted a solved problem as
an open one.
