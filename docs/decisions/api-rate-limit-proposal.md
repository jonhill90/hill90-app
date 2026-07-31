# Proposal: a rate limit for `api.hill90.com`

**Status: proposal, not applied.** This is the public edge and the decision is Jon's. What
follows is a number, the measurement behind it, and what it does not protect against.

Measured 2026-07-31, read-only against production.

## The asymmetry that prompted this

`app-ui` carries `rate-limit@file` — average **100 req/s**, burst **50**. `app-api` carries
**no middleware at all**. That is not an exposure: the API is intended to be public and
authenticates its callers. But it looks unintended rather than decided, and the API is the
more attackable of the two surfaces.

The middleware is defined in the platform's Traefik file provider; the *reference* would be
a label on `app-api` in this repository. Platform owns the definition, tenant owns the
reference.

## What the traffic actually looks like

Source: Traefik's Prometheus metrics, `traefik_router_requests_total`, which the platform
scrapes and which carries router labels. Seven days, counter resets handled with
`increase()`.

| Measure | `app-api@docker` | `app-ui@docker` |
|---|---|---|
| Total requests, 7 days | **297** | 2,566 |
| Mean sustained rate | **0.00049 req/s** — about one request every 34 minutes | 0.0042 req/s |
| **Peak 1-minute rate** | **0.99 req/s** | 2.42 req/s |
| Minutes (of 10,080) with any traffic | **34** — 0.34% | — |
| Minutes exceeding 1 req/s | **zero** | — |

By response code over the same 7 days: 404 × 172, 200 × 96, 401 × 13, 403 × 8, 201 × 2,
500 × 2, and 4 requests logged as code `0` (WebSocket upgrades, which Traefik does not
score).

**`app-ui` already runs with a limit 41× its own observed peak** and has never been
rejected. That is the closest thing to a proven-safe ratio this estate has.

## Page-load fan-out does not cross this router, and that changes the question

The obvious worry — that a limit set below a real page load breaks the product — does not
apply here, and this was verified rather than assumed.

`app-ui`'s container environment sets **`API_URL=http://api:3000`**. The UI proxies browser
API calls **server-side, over the internal network, by container name**. Those requests
never reach `api.hill90.com` and would never be counted by a limit on that router. The 7-day
totals corroborate it: the UI router served 2,566 requests while the API router served 297.

What actually crosses `api.hill90.com` is: the terminal WebSocket, and any direct API client.
There is no page-load fan-out to accommodate.

## The proposal

**Attach the existing `rate-limit@file` to `app-api` — average 100 req/s, burst 50.**

- **Requests in the observed sample that would have been rejected: zero.** The peak
  1-minute rate was 0.99 req/s against an average allowance of 100/s; no minute in seven
  days exceeded 1 req/s, so nothing came within two orders of magnitude of the limit.
- Headroom over observed peak: **~101×**. For comparison the UI runs at ~41× and is
  untroubled.
- It is the same value, already proven in production on the sibling router, which makes it
  the lowest-risk number available. Any other number needs its own justification.

**Why not tighter, even though the traffic is minuscule.** The sample is dominated by
synthetic traffic — 172 of 297 requests were 404s from this session's own probing, and
production currently has **zero agents and zero chat threads**, so there is almost no
organic API use to measure. Sizing a limit to today's near-zero traffic would be false
precision, and it would be wrong the moment agents actually run. The number is chosen for
consistency and headroom, not fitted to the sample.

**Why not leave it off.** The asymmetry is unexplained, the sibling router is already
protected, and the cost of the change is one label.

## What it does not protect against

Recording this so the limit is not later cited as broader protection than it is.

- **Request count is not cost.** A rate limit counts requests, not work. One expensive
  query per second — a large knowledge search, an unindexed scan — stays far inside 100/s
  while consuming the database. This does nothing about a slow expensive endpoint.
- **A single authenticated client hammering one route.** 100 req/s per source is generous;
  an authenticated abuser pointed at one endpoint never approaches it. Per-route and
  per-principal limits are a different mechanism and this is not one.
- **Distributed sources.** Traefik's `rateLimit` keys on the client address, so N sources
  get N × the allowance. It raises the cost of a single-host flood and does nothing to a
  spread one.
- **The terminal WebSocket after its handshake.** An upgrade is one request; the long-lived
  stream that follows is not rate limited at all. Since the WebSocket is the main
  edge-facing API surface, the limit's practical reach on real traffic is small.
- **Authorization.** It is not a substitute for the role and participation checks, which
  are what actually keep callers out of other people's data.

## What the estate could not tell me, which is its own finding

- **Traefik's access log retains only failures.** `accessLog.filters.statusCodes` is
  `400-599`, so successful requests are never written. There is no per-request record of
  normal traffic anywhere on the host, and no path-level distribution can be recovered from
  logs. That is why this proposal rests on metrics rather than logs.
- **Traefik's metrics have no path dimension.** `addRoutersLabels: true` gives router-level
  counters only. A per-endpoint limit cannot be sized from the data that exists — it would
  need either access-log sampling for 2xx or application-level instrumentation.
- **Loki holds `app-api`'s application logs** (≈256 lines in 24 h) but no access logs, so it
  adds nothing to a rate question.
- **Prometheus retains 7 days.** There is no seasonal or monthly view, so "peak" here means
  peak within a week that was itself atypical.

None of those block this proposal. All of them would block sizing a per-route limit, which
is the obvious next request and is not currently answerable.
