# Contributing to hill90-app

This repository is **shelved**. There is no active development, no deployment
target, and no CI that runs on its own. Read [`RESURRECTION.md`](RESURRECTION.md)
before changing anything.

What follows is the working convention inherited from Hill90, kept because it is
what the 542 commits of history already follow. The deploy rules, secrets
workflow, and VPS operations from Hill90's `CONTRIBUTING.md` are deliberately
**not** reproduced — none of that tooling came with the app.

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
