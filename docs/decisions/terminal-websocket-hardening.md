# The terminal WebSocket: Origin checked, token out of the URL, proven in production

**Status:** shipped in #67, deployed 2026-07-31, and **verified against production on
2026-07-31**. This record exists because the fix was live for a while with nobody having
demonstrated that it works, and because the obvious way to test it proves nothing.

## What was wrong

`services/api/src/services/terminal-proxy.ts` relays a browser WebSocket to an agent's PTY.
Two defects, both confirmed by reading the code before anything was changed:

1. **No Origin check.** The upgrade handler never read `req.headers.origin`. WebSockets are
   not covered by the same-origin policy and CORS does not apply to the handshake, so any
   page a signed-in user visited could open this socket — the browser attaches the
   credential — and drive a shell inside their agent container.
2. **The token came from the query string**, read *before* the `Authorization` header. URLs
   reach access logs, proxy logs and browser history. This service also wrote the token into
   its own log line on every upgrade, which was a third exposure nobody had noticed.

## What it is now

An exact-match origin allowlist from `TERMINAL_ALLOWED_ORIGINS`, checked **before any
credential is examined** — so a refused origin cannot learn whether the token it captured is
valid. Exact match because suffix matching would accept `hill90.com.evil.example` and
host-only comparison would accept the wrong scheme or port. Unset or empty **refuses
everything**; a permissive default is the defect being fixed.

The token travels as a WebSocket subprotocol, `hill90.bearer.<token>`, alongside a plain
`hill90.terminal.v1`. The browser's WebSocket API cannot set an `Authorization` header, which
rules out the obvious fix; a subprotocol is a request *header* and needs no server state. A
short-lived single-use ticket was the alternative and was rejected: it needs ticket state,
and with more than one api replica that state must be shared or the ticket only works on the
replica that minted it. **The query-string path was removed, not deprecated** — accepting
both would have left the logging exposure in place while looking fixed. Only the plain
version string is echoed back, never the bearer one, because response headers are logged too.

## The verification, and why the obvious test is worthless

**Do not "test" this by probing the endpoint without a credential.** An unauthenticated
handshake returns 401 whatever the Origin is, so a 401 from a cross-origin probe cannot
distinguish *"refused because the Origin was wrong"* from *"refused because there was no
valid credential"*. That mistake was made twice on this fix — once by an operator whose probe
returned 401 for everything, and once by an agent whose probe went out over HTTP/2, where
`Connection: Upgrade` is meaningless, so all of it was ordinary GETs hitting normal auth
middleware. Force HTTP/1.1 and carry a real token, or you are measuring nothing.

The discriminating test is **one genuinely valid token, used three times, varying only where
it is carried and which Origin declares it.** Against production on **2026-07-31**, with a
`testuser01` access token obtained through a real authorization-code login:

| # | Request | Observed |
|---|---|---|
| 1 | valid token in subprotocol, Origin `https://hill90.com` (allowed) | **`HTTP/1.1 101 Switching Protocols`** |
| 2 | **same** token in subprotocol, Origin `https://evil.example` (disallowed) | **`HTTP/1.1 403 Forbidden`** |
| 3 | **same** token in the **query string**, Origin `https://hill90.com` (allowed) | **`HTTP/1.1 401 Unauthorized`** |

Repeated three consecutive rounds, identical every time. All three were run; none was
skipped or inferred.

Line 1 is what makes lines 2 and 3 mean anything: the same credential *does* upgrade, so the
refusals are the Origin check and the dead query-string path doing their jobs rather than a
uniform rejection. The response to line 1 contained **zero** occurrences of the token, so the
subprotocol is not echoed back.

Corroborated server-side: line 1 logged `Resolved agentbox URL … found`; line 2 logged
`REFUSED upgrade: origin 'https://evil.example' not in allowlist (2 origin(s) configured)`;
line 3 logged `REFUSED upgrade: no token in Sec-WebSocket-Protocol or Authorization`. The
log line for a request carrying `?token=` printed `…/terminal?<redacted>`, with zero
occurrences of the value sent — the third defect, fixed and confirmed live.

`TERMINAL_ALLOWED_ORIGINS` in the running container reads
`https://hill90.com,https://www.hill90.com` — real hostnames, no unexpanded `${`, which is
worth checking explicitly because a compose default that interpolates to something plausible
but wrong fails silently.

### What it took to reach a 101, and why an earlier attempt got 404

Production had **zero agents and zero threads**, so a valid token from an allowed origin
reached the *last* gate and returned 404 — "no running agent for this thread". That is not a
failure of the fix, but it is not a proof either. Reading the handler shows
`wss.handleUpgrade` completes the 101 **before** dialling agentbox, so a 101 needs only an
`agents` row with `status='running'` — no container.

The fixture was one agent row, one thread and two participant rows, all deleted afterwards
and verified back to `agents=0 threads=0 participants=0`, with **zero** agentbox containers
created. Anyone re-running this should do the same and check the counts after, not assume.

## Deploy coupling, which is easy to get wrong

`api` and `ui` must deploy **together**. An old ui against the new api sends `?token=` and
gets 401; a new ui against an old api sends a subprotocol the old server ignores and gets
401. Deployed api first on 2026-07-31, then ui: either order breaks the terminal for the same
duration, and api-first closes the vulnerability at the earliest moment. Browsers cache the
old bundle, so ui-first would not switch open tabs anyway and would leave the hole open
longer for no availability gain.

## Still not proven

**A terminal session carrying real shell traffic.** Line 1 proves the handshake upgrades; it
does not prove a working PTY, because the fixture agent had no container behind it. Doing
that end to end needs a real agent started in production. The regression risk it would cover
is real and it remains open.

## Known rough edge, not a security hole

A thread id that is not a UUID reaches `isParticipant` and throws
`invalid input syntax for type uuid`, which surfaces as **502** plus a stack trace in the
logs instead of a 400 or 404. It is after authentication, so nothing is bypassed, but it
should be validated at the edge.
