# The 2026-08-03 hardening batch: what is in it, and how each part will be verified

**Status:** merged, **not deployed**. This file exists so "merged" is never read as
"live", and so the verification plan is written down *before* the deploy rather than
assembled afterwards from memory.

## Why these are batched rather than deployed one at a time

Each is hardening with **no reported exploit**: a bound added where none existed, on a
path nobody has been observed to abuse. That is a different case from
[#136](https://github.com/jonhill90/hill90-app/pull/136), where an unauthenticated
endpoint was answering 200 on the public internet while we watched, and which was
therefore deployed immediately and verified from outside.

Deploying per-PR costs a pipeline run, a container restart and a verification pass each
time. For this class the cost is not worth paying per change, so they land and go out
together.

**The risk of batching is drift** — merged work that nobody deploys, and nobody
remembers is undeployed. Two rules keep it from becoming that:

1. **Every PR in the class says so in its body**, up front: *merged is not live*. Nobody
   should have to infer deployment state from a merge date.
2. **At deploy time each fix is verified individually.** A batch that half-lands is
   harder to notice than a single change that fails outright — the deploy goes green
   either way.

## The batch

| PR | Service | What it bounds |
|---|---|---|
| [#146](https://github.com/jonhill90/hill90-app/pull/146) | `ui` | request bodies read whole into the process, no ceiling |
| [#147](https://github.com/jonhill90/hill90-app/pull/147) | `ui` | upstream responses buffered with no ceiling |
| [#148](https://github.com/jonhill90/hill90-app/pull/148) | `api` | terminal WebSocket relay queued without limit for a stalled peer |
| [#150](https://github.com/jonhill90/hill90-app/pull/150) | `api` | SSE writes ignored backpressure; a stalled client buffered without limit |

Already deployed, and therefore **not** in the batch — checked against deploy timestamps
rather than assumed: #141 and #143 (both precede the 19:24 UTC `api` deploy), and #145
(precedes both the 19:24 `api` and 19:27 `ui` deploys).

## Verified behaviourally, or only by containment

**This distinction is the point of the file.** Some of these can be observed working from
outside after the deploy. Some cannot, and saying so is more useful than a green deploy
that implies more than it proves.

| PR | Verification at deploy time | Kind |
|---|---|---|
| #146 | POST an oversized body to a UI API route from outside; expect a refusal, not a 200 | **Behavioural** |
| #147 | Requires the upstream API to return an oversized body, which cannot be manufactured from outside | **Containment only** |
| #148 | Requires an authenticated terminal session *and* a peer that stalls mid-session | **Containment only** |
| #150 | Requires an authenticated SSE subscriber that stops reading while an agent produces output | **Containment only** |

**"Containment only" means exactly this and no more:** the deployed commit contains the
fix, and the surfaces it touches show no regression. It does **not** mean the bound was
observed to trip in production. Anyone reading a green deploy as proof that #147, #148 or
#150 *work in production* is reading more than the evidence carries.

That is an accepted limit, not an oversight. The alternative considered and **rejected**
was a temporary log line at the point each bound trips: a log that must be remembered and
removed is a new instance of the family being closed here, and its failure mode is that it
stays. For hardening with no reported exploit, containment is adequate evidence provided
the word "containment" is used.

Each fix also carries tests that fail without it — #150's end-to-end case was run against
`origin/main` to confirm it goes red there, and #148's was measured at the proxy with 9 MB
already queued. Those are the behavioural evidence; they run in CI, not in production.

## Where the bounds came from

Not invented per-site. `services/knowledge/app/services/web_page_fetcher.py` already
enforced 2 MB incrementally on HTTP bodies, and that figure and shape were reused: 2 MB
for a single read, 8 MB for a relay or stream queue, backpressure applied first and the
hard cap kept for what backpressure cannot fix — a peer that is not reading at all.

## The structural gap none of these closes

[Issue #144](https://github.com/jonhill90/hill90-app/issues/144): `api`, `ui` and `mcp`
declare no `mem_limit`, while `litellm` (1g), `ai` (512m), `knowledge` (512m) and even the
`docker-proxy` sidecar (128m) do. Every fix in this batch narrows what can be consumed;
none of them puts a ceiling on the container. On a VPS shared with the platform, that
ceiling is the host's memory.
