"""Web page fetcher with SSRF protection.

Implements the Fetch Safety Contract:
- URL validation (scheme, credentials, port, internal hostnames)
- Pre-connect DNS resolution check against blocked CIDR ranges
- The connection itself dials the address that check validated — not a
  second, independent resolution (app#545)
- Manual redirect following with re-validation on every hop
- Error messages omit resolved IP addresses
- Response size limits
- Non-2xx HTTP status rejected before extraction (#437)

This list is the contract, not a description of it — #437 found and fixed a
missing check (non-2xx status) here BECAUSE this docstring claimed
completeness and stopped at five items. Keep this list and the code in the
same commit as any future item; the artifact whose incompleteness caused
that defect is this one.

APP#545 — WHY THE CONNECTION LAYER HAD TO CHANGE, NOT JUST THE CHECK.
`_resolve_and_check` validated a hostname's resolved IP before every
connection attempt, including on every redirect hop — but the actual
connection never used that resolution. `httpx.AsyncClient` was constructed
with no `transport=` override, so it resolved the SAME hostname again,
independently, at connect time. Two separate calls to the OS resolver for
the same hostname is a textbook DNS-rebinding window: a hostname with a
very low or zero TTL, served by a resolver that honors it, can legitimately
answer differently a few milliseconds apart. The check would validate one
answer; the connection would dial whatever the second, unrelated lookup
returned.

THREE OPTIONS WERE WEIGHED, not just the one shipped:

1. IP-pinning by rewriting the request to target the literal IP (the
   fix this issue itself first suggested) — connect to the validated
   address directly, carrying the original Host header and SNI by hand.
   Closes the window, but naively done it also BREAKS things: a
   hand-rolled "connect to this IP, but still verify this hostname's TLS
   cert" needs the SNI and hostname-verification logic reproduced exactly
   right per-request, and a URL that IS the pinned IP stops working for
   any legitimately multi-IP host if only one address is ever tried.

2. A custom resolver/transport that hands httpx an already-validated
   address instead of letting httpx resolve on its own — the shape
   actually shipped, detailed below.

3. Re-validate deeper inside the connection path, after httpx has already
   resolved and is about to connect — rejected: by the time anything past
   httpx's own resolution can observe an address, the TOCTOU has already
   happened; validating a THIRD time after an independent SECOND
   resolution does not close the gap between validation and connection,
   it just moves it.

OPTION 2, CHOSEN, AND WHAT IT GIVES UP. `_SsrfSafeNetworkBackend` below
overrides `httpcore.AnyIOBackend.connect_tcp` — the exact call httpx's
default transport delegates a connection's DNS resolution and TCP dial to.
This is the ONE hook in the whole stack where "resolve" and "connect to
what was resolved" can be made atomic: `connect_tcp` receives a hostname,
and this override resolves it itself (`_resolve_all_validated`, the same
blocklist logic `_resolve_and_check` already used), validates every
candidate, and dials one of the validated candidates directly — with no
second, independent resolution able to occur in between, because none is
ever made. TLS is UNAFFECTED by construction, not by care taken to
preserve it: SNI and hostname verification happen in a separate step
(`AsyncNetworkStream.start_tls`, called by httpcore AFTER `connect_tcp`
returns) that receives the ORIGINAL hostname regardless of which IP the
socket connected to — this codebase never has to reconstruct that logic
by hand, unlike option 1. Round-robin/multi-address hosts are preserved
too: EVERY candidate `getaddrinfo` returns is validated (a single blocked
candidate among several still refuses the whole hostname, matching
`_resolve_and_check`'s existing conservative behaviour), and connect_tcp
tries each validated candidate in turn — a host with several equally
valid addresses keeps failing over exactly as an unguarded client would,
because none of its options were ever ruled out on validation grounds
alone.

What this gives up, stated rather than left implicit: a CDN or host that
deliberately returns a DIFFERENT valid address on every single connection
attempt (not just on retry) will see that entropy reduced to "whatever
this one resolution returned" for the lifetime of ONE connection — the
same granularity `_resolve_and_check`'s per-hop re-validation already
assumed (a fresh resolution happens per hop / per new connection, not
once for the whole fetch), so this is not a NEW narrowing, but it is
real: a backend relying on picking a fresh address on every single TCP
handshake to the same origin, faster than httpcore's connection pooling
would reuse one, will not see that from this fetcher.
"""

from __future__ import annotations

import ipaddress
import socket
import ssl
from typing import Any
from urllib.parse import urlparse

import httpcore
import httpx
import structlog
import trafilatura

logger = structlog.get_logger()

MAX_RESPONSE_BYTES = 2 * 1024 * 1024  # 2 MB
MAX_REDIRECTS = 3
CONNECT_TIMEOUT = 10.0  # seconds
READ_TIMEOUT = 30.0  # seconds
USER_AGENT = "Hill90-KnowledgeService/1.0"
ALLOWED_PORTS = {80, 443}
# shared_sources.title and shared_documents.title are both varchar(512). A page
# with a longer <title> would otherwise turn a successful fetch into a database
# error at insert time, which is a worse failure than a truncated title.
MAX_TITLE_LENGTH = 512

# Docker service hostnames that must never be fetched
BLOCKED_HOSTNAMES = frozenset({
    "postgres",
    "api",
    "ai",
    "keycloak",
    "litellm",
    "openbao",
    "minio",
    "tempo",
    "knowledge",
    "docker-proxy",
    "promtail",
    "loki",
    "prometheus",
    "grafana",
})

# Tailscale/CGNAT range not covered by is_private in all Python versions
_TAILSCALE_CGNAT = ipaddress.ip_network("100.64.0.0/10")


class FetchError(Exception):
    """Raised when URL fetch fails validation or network checks."""


def _is_blocked_ip(ip_str: str) -> bool:
    """Check if an IP address falls in any blocked range.

    Expects a valid IP address string. Returns False for unparseable
    strings (hostnames are checked separately).
    """
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return False  # Not an IP address (e.g. hostname) — checked elsewhere

    if addr.is_loopback:
        return True
    if addr.is_private:
        return True
    if addr.is_link_local:
        return True
    if addr.is_reserved:
        return True
    if addr.is_multicast:
        return True
    if addr.is_unspecified:
        return True

    # Explicit Tailscale/CGNAT check (100.64.0.0/10)
    if isinstance(addr, ipaddress.IPv4Address) and addr in _TAILSCALE_CGNAT:
        return True

    return False


def _validate_url(url: str) -> tuple[str, str, int | None]:
    """Validate URL before any network I/O.

    Returns (scheme, hostname, port) if valid.
    Raises FetchError with category-only message if invalid.
    """
    parsed = urlparse(url)

    # Step 1-2: scheme
    if parsed.scheme not in ("http", "https"):
        raise FetchError(f"URL scheme '{parsed.scheme}' is not allowed; only http/https are accepted")

    # Step 3: hostname
    hostname = parsed.hostname
    if not hostname:
        raise FetchError("URL has no hostname")

    # Step 5: credentials
    if parsed.username or parsed.password:
        raise FetchError("URL must not contain credentials (user:pass@host)")

    # Step 6: internal hostnames (check before port to give clearer errors)
    hostname_lower = hostname.lower()
    if hostname_lower in BLOCKED_HOSTNAMES:
        raise FetchError(f"Hostname '{hostname_lower}' matches an internal service name")

    # Step 4: port
    port = parsed.port
    if port is not None and port not in ALLOWED_PORTS:
        raise FetchError(f"Non-standard port {port} is not allowed; only 80 and 443 are accepted")

    # Check if hostname is an IP literal in a blocked range
    try:
        ipaddress.ip_address(hostname)
        # It's an IP literal — check against blocked ranges
        if _is_blocked_ip(hostname):
            raise FetchError("URL points to a blocked IP address range")
    except ValueError:
        pass  # Not an IP literal — will resolve via DNS later

    return parsed.scheme, hostname, port


def _resolve_all_validated(hostname: str, resolve_port: int) -> list[str]:
    """Resolve hostname via DNS ONCE and validate every candidate.

    Returns the validated IP literals in the order the resolver returned
    them. Raises FetchError if ANY resolved candidate is blocked — the same
    all-or-nothing posture `_resolve_and_check` always had: a hostname that
    answers with one public and one internal address is refused entirely,
    not served from whichever candidate happened to look safe.

    THE SHARED CORE of app#545's fix. `_resolve_and_check` (the pre-connect
    fast-fail check) and `_SsrfSafeNetworkBackend.connect_tcp` (the actual
    security boundary, since it is what the connection dials) call this
    SAME function rather than each maintaining their own copy of the
    blocklist-scanning loop — the twin-drift shape this codebase has hit
    before (parseMemLimit/parseCpus, install_ref/tool.name): one guarded,
    its sibling not, because they were never the same code to begin with.
    """
    try:
        results = socket.getaddrinfo(hostname, resolve_port, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise FetchError(f"DNS resolution failed for hostname '{hostname}'")

    if not results:
        raise FetchError(f"DNS resolution returned no results for hostname '{hostname}'")

    validated: list[str] = []
    for family, _type, _proto, _canonname, sockaddr in results:
        ip_str = str(sockaddr[0])
        if _is_blocked_ip(ip_str):
            raise FetchError(
                f"Hostname '{hostname}' resolves to a blocked private/internal IP address range"
            )
        validated.append(ip_str)
    return validated


def _resolve_and_check(hostname: str, port: int | None) -> None:
    """Resolve hostname via DNS and check all IPs against blocked ranges.

    Raises FetchError if any resolved IP is blocked.
    Does NOT include the resolved IP in the error message.

    A FAST PRE-CHECK, NOT THE SECURITY BOUNDARY (app#545). This runs before
    any network I/O so a caller gets a clean FetchError instead of whatever
    exception shape the network layer would produce — but it is not what
    makes a blocked address unreachable. `_SsrfSafeNetworkBackend` is: it
    performs this same validation again, atomically with the actual
    connection, so a caller that somehow reached the connection layer
    without going through this pre-check would still be safe.
    """
    resolve_port = port or 443
    _resolve_all_validated(hostname, resolve_port)


class _SsrfSafeNetworkBackend(httpcore.AnyIOBackend):
    """Resolves and validates INSIDE connect_tcp, atomically with the dial.

    app#545. This is the actual fix: `connect_tcp` is the one place in the
    whole httpx/httpcore stack where "resolve a hostname" and "connect to
    what was resolved" can be made the same operation. The default backend
    (this class's own parent) resolves the hostname itself via
    `anyio.connect_tcp`, independently of whatever `_resolve_and_check`
    validated earlier — the TOCTOU. This override resolves and validates
    FIRST, then hands the validated literal IP to the parent's own
    `connect_tcp`, which — given a literal IP instead of a hostname —
    performs no further resolution at all; there is no second lookup left
    for a rebinding DNS answer to be seen by.

    EVERY VALIDATED CANDIDATE IS TRIED, not just the first, so a host with
    several equally valid addresses (round-robin, multi-region) keeps
    failing over exactly as an unguarded client would — nothing here
    reduces a legitimately multi-address host to a single one; it only
    ever removes candidates that were blocked outright.
    """

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        import anyio

        try:
            candidates = await anyio.to_thread.run_sync(_resolve_all_validated, host, port)
        except FetchError as exc:
            # Re-raised as httpcore.ConnectError, not left as FetchError:
            # httpcore's own connection-establishment machinery only
            # expects ConnectError out of connect_tcp, and fetch_and_extract
            # already has a clean `except httpx.ConnectError` branch that
            # turns this back into a FetchError with the message intact —
            # letting a raw FetchError escape here would otherwise get
            # swallowed into httpcore's own generic "All connection attempts
            # failed", losing exactly the detail this exists to report.
            raise httpcore.ConnectError(str(exc)) from exc

        last_exc: Exception | None = None
        for ip in candidates:
            try:
                return await super().connect_tcp(
                    host=ip,
                    port=port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            # ConnectTimeout too, not just ConnectError — a candidate that
            # hangs rather than refusing outright must still fall back to
            # the next one. Catching only ConnectError left a genuinely
            # unresponsive (not merely refused) candidate free to consume
            # the connection's entire timeout budget on its own, before a
            # perfectly reachable second candidate was ever tried — found
            # by exercising the fallback loop with a real unresponsive
            # address, not by reading the two exception types apart.
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last_exc = exc
                continue
        assert last_exc is not None  # candidates is never empty — _resolve_all_validated guarantees it
        raise last_exc


def _build_ssrf_safe_transport(ssl_context: ssl.SSLContext) -> httpx.AsyncHTTPTransport:
    """An httpx transport whose connections dial exactly what was validated.

    NOT `httpx.AsyncHTTPTransport(verify=ssl_context)` — that builds its own
    `httpcore.AsyncConnectionPool` with the default network backend
    (`httpcore.AnyIOBackend`, unmodified), which is precisely the object
    app#545 exists to replace. `httpx.AsyncHTTPTransport.__init__` does not
    accept a `network_backend=` override, so this builds the same
    `httpcore.AsyncConnectionPool` httpx would have, by hand, with
    `_SsrfSafeNetworkBackend` in place of the default — and reuses
    `httpx.AsyncHTTPTransport`'s own `handle_async_request`/`aclose` by
    assigning to `self._pool`, the exact attribute those methods read.
    Reaching into that attribute is deliberate, not a shortcut: both of
    those methods are short, stable, and already read directly from
    `httpx`'s source above to confirm what they need — reproducing them
    independently would be MORE fragile against a future httpx change,
    not less, since it would silently stop tracking whatever
    `handle_async_request` does next.
    """
    transport = httpx.AsyncHTTPTransport(verify=ssl_context)
    transport._pool = httpcore.AsyncConnectionPool(
        ssl_context=ssl_context,
        network_backend=_SsrfSafeNetworkBackend(),
    )
    return transport


async def fetch_and_extract(url: str) -> dict[str, Any]:
    """Fetch a web page and extract its text content.

    Returns dict with keys: url, title, content, content_type.
    Raises FetchError on validation failure, network error, or extraction failure.
    """
    # URL validation (before any network I/O)
    scheme, hostname, port = _validate_url(url)

    # DNS resolution check (before HTTP connect)
    _resolve_and_check(hostname, port)

    current_url = url
    redirects = 0

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(connect=CONNECT_TIMEOUT, read=READ_TIMEOUT, write=READ_TIMEOUT, pool=READ_TIMEOUT),
        follow_redirects=False,
        headers={"User-Agent": USER_AGENT},
        # NOT verify=ssl.create_default_context() — that lets httpx build its
        # own default transport, the one app#545 exists to replace. The
        # ssl_context still goes in, just carried by our own transport instead
        # (see _build_ssrf_safe_transport's own docstring for why).
        transport=_build_ssrf_safe_transport(ssl.create_default_context()),
    ) as client:
        while True:
            try:
                response = await client.send(
                    client.build_request("GET", current_url),
                    stream=True,
                )
            except httpx.ConnectTimeout:
                raise FetchError(f"Connection timed out fetching '{hostname}'")
            except httpx.ReadTimeout:
                raise FetchError(f"Read timed out fetching '{hostname}'")
            except httpx.ConnectError as exc:
                raise FetchError(f"Connection failed for '{hostname}': {exc}")
            except httpx.HTTPError as exc:
                raise FetchError(f"HTTP error fetching '{hostname}': {exc}")

            # Handle redirects manually with re-validation
            if response.is_redirect:
                await response.aclose()
                redirects += 1
                if redirects > MAX_REDIRECTS:
                    raise FetchError(
                        f"Too many redirects (max {MAX_REDIRECTS}) fetching '{hostname}'"
                    )

                location = response.headers.get("location", "")
                if not location:
                    raise FetchError("Redirect response missing Location header")

                # Resolve relative redirects
                if location.startswith("/"):
                    parsed_current = urlparse(current_url)
                    location = f"{parsed_current.scheme}://{parsed_current.netloc}{location}"

                # Re-validate the redirect target
                redir_scheme, redir_hostname, redir_port = _validate_url(location)
                _resolve_and_check(redir_hostname, redir_port)

                current_url = location
                continue

            # A non-2xx status must fail the fetch here, before extraction —
            # not after. trafilatura does not know a 404/500 page's body is an
            # error page rather than content; a page like "404 Not Found — the
            # page you requested does not exist" extracts real, non-empty text
            # just as cleanly as a real article, so the "not empty" check
            # below cannot catch it. Left unchecked, ingest.py has no way to
            # tell it received an error page and marks the job completed, the
            # source active, with real chunks that are not what anyone asked
            # to ingest.
            if response.status_code < 200 or response.status_code >= 300:
                status_code = response.status_code
                await response.aclose()
                raise FetchError(
                    f"Fetching '{hostname}' returned HTTP {status_code}, not a successful response"
                )

            # Non-redirect response — check Content-Length header first
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > MAX_RESPONSE_BYTES:
                await response.aclose()
                raise FetchError(
                    f"Response size {int(content_length)} bytes exceeds limit of {MAX_RESPONSE_BYTES} bytes"
                )

            # Stream body with incremental size enforcement
            chunks: list[bytes] = []
            bytes_read = 0
            try:
                async for chunk in response.aiter_bytes(chunk_size=65536):
                    bytes_read += len(chunk)
                    if bytes_read > MAX_RESPONSE_BYTES:
                        raise FetchError(
                            f"Response body exceeds size limit of {MAX_RESPONSE_BYTES} bytes"
                        )
                    chunks.append(chunk)
            finally:
                await response.aclose()

            body = b"".join(chunks)
            break

    # Extract content with trafilatura
    content_type = response.headers.get("content-type", "text/html")
    encoding = response.charset_encoding or "utf-8"
    html = body.decode(encoding, errors="replace")
    extracted = trafilatura.extract(html)

    if not extracted or not extracted.strip():
        raise FetchError(f"Could not extract readable content from URL '{hostname}'")

    # Title from the page's own metadata, falling back to the hostname.
    #
    # This used to call trafilatura.extract(html, output_format="xmltei") and
    # never read the result, so `title` was ALWAYS the hostname. ingest.py
    # consumes this value whenever the caller supplied no title or passed the URL
    # as one, so the fallback was reachable from the UI — it just had not been hit
    # yet. `extract_metadata` is the API that returns a document with .title;
    # xmltei returns TEI XML with the title buried inside it.
    title = hostname
    try:
        metadata = trafilatura.extract_metadata(html)
    except Exception:
        # A page whose metadata cannot be parsed should not fail an ingest whose
        # content extracted cleanly a few lines above. Logged rather than silent.
        metadata = None
        logger.warning("web_page_metadata_extraction_failed", url=url, hostname=hostname)

    if metadata is not None:
        extracted_title = (metadata.title or "").strip()
        if extracted_title:
            title = extracted_title[:MAX_TITLE_LENGTH]

    logger.info(
        "web_page_fetched",
        url=url,
        hostname=hostname,
        content_length=len(extracted),
    )

    return {
        "url": url,
        "title": title,
        "content": extracted,
        "content_type": content_type,
    }
