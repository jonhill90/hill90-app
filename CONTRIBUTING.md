# Contributing to hill90-app

This repository is **shelved**. There is no active development, no deployment
target, and no CI that runs on its own. Read [`RESURRECTION.md`](RESURRECTION.md)
before changing anything.

What follows is the working convention inherited from Hill90, kept because it is
what the 542 commits of history already follow. The deploy rules, secrets
workflow, and VPS operations from Hill90's `CONTRIBUTING.md` are deliberately
**not** reproduced — none of that tooling came with the app.

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

## If you resurrect this

- Work through `RESURRECTION.md` item by item; each is a self-contained change.
- Update `services/api/src/openapi/openapi.yaml` when adding or changing API
  routes. Hill90's CI enforced spec-vs-route drift and also diffed that file
  against `docs/site/openapi.yaml`; neither check came across, so the two may
  already disagree.
- Tests live next to their services: `services/api` (jest), `services/ui`
  (vitest), `services/mcp` and `services/agentbox` (pytest). End-to-end
  Playwright suites are in `tests/e2e/` and require a running stack.
- Do not commit real secrets. `.env.example` files are tracked; `.env` is not.

## History

Commits before 2026-07-26 were rewritten by `git filter-repo` during extraction
and have different SHAs than their Hill90 originals.
[`docs/extraction/commit-map.txt`](docs/extraction/commit-map.txt) maps old to
new. Commits from before `refactor: restructure to ops-first monorepo layout
(#124)` reference paths under `src/services/`, which is where this code lived
until then.
