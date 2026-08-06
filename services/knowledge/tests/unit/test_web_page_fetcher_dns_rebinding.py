"""app#545: DNS rebinding bypasses the SSRF guard's IP validation (TOCTOU).

THE HOLE. `_resolve_and_check` validated a hostname's resolved IP once,
before any network I/O. The actual connection then resolved the SAME
hostname a SECOND, independent time — httpx's default transport, via
httpcore's default `httpcore.AnyIOBackend`. Two separate calls to the OS
resolver for one hostname is the textbook DNS-rebinding window: a hostname
with a very low or zero TTL can legitimately answer differently a few
milliseconds apart, and the guard has no way to know its answer is stale by
the time the connection is actually made.

WHY THIS FILE TESTS `connect_tcp` DIRECTLY, NOT THROUGH `fetch_and_extract`.
`_validate_url` only allows ports 80/443 — deliberately, and untouched by
this fix — and this sandbox cannot bind a real listener on either without
root. Measured directly: `anyio`/`asyncio`'s own `create_connection` ALWAYS
uses the ORIGINALLY REQUESTED port for the real connect, discarding whatever
port a resolved sockaddr carries (confirmed empirically — a mocked
`getaddrinfo` returning a different port than requested is silently
ignored; the port a caller asked to connect to is the port used, regardless
of what the resolver answered). So a test attacker listening on an
arbitrary ephemeral port cannot be reached by smuggling that port through a
fake DNS answer at the `fetch_and_extract` URL level — the demonstration
has to happen where `connect_tcp` itself is called with an arbitrary port,
which is the ACTUAL security boundary the fix lives in, and one level
below where the port allowlist applies at all.

THE DEMONSTRATION: a hostname's DNS resolution returns a safe-looking
public address on the FIRST lookup and a blocked, real, LISTENING local
address on the SECOND — the exact two-resolutions shape #545 describes.
Pre-fix (`httpcore.AnyIOBackend`, httpx's actual unmodified default),
the connection reaches the second, "rebound" address for real: bytes are
exchanged with a live local listener standing in for an internal service.
Post-fix (`_SsrfSafeNetworkBackend`), the same two-resolution sequence
results in the connection being refused before it is ever attempted — the
listener receives nothing.
"""

from __future__ import annotations

import socket

import anyio
import httpcore
import pytest

from app.services.web_page_fetcher import FetchError, _SsrfSafeNetworkBackend


class _TwoAnswerResolver:
    """Stands in for a rebinding-capable DNS server.

    First call to `getaddrinfo` for TARGET_HOST returns a safe-looking
    public address (never actually dialed in these tests — nothing needs to
    listen there). The SECOND and every subsequent call returns the
    "attacker" address instead — a real local listener this test controls.
    Any other hostname is resolved for real, so this does not have to
    reimplement resolution for anything the test infrastructure itself
    needs (e.g. asyncio's own re-resolution of an already-literal IP during
    connect — see the module docstring above; that call must pass through
    untouched or it corrupts the very connection this test is trying to
    observe).
    """

    TARGET_HOST = "rebinding-target.example"
    SAFE_ANSWER = ("93.184.216.34", 443)  # never dialed; just needs to validate as public

    def __init__(self, attacker_addr: tuple[str, int]) -> None:
        self._attacker_addr = attacker_addr
        self._real = socket.getaddrinfo
        self.calls_for_target = 0

    def __call__(self, host, port, *args, **kwargs):
        h = host.decode() if isinstance(host, bytes) else host
        if h != self.TARGET_HOST:
            return self._real(host, port, *args, **kwargs)
        self.calls_for_target += 1
        addr = self.SAFE_ANSWER if self.calls_for_target == 1 else self._attacker_addr
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", addr)]


class _Attacker:
    """A real local TCP listener standing in for an internal service."""

    def __init__(self) -> None:
        self.received: list[bytes] = []
        self._listener: anyio.abc.SocketListener | None = None

    async def start(self) -> tuple[str, int]:
        self._listener = await anyio.create_tcp_listener(local_host="127.0.0.1", local_port=0)
        import anyio.abc as abc

        host, port = self._listener.extra(abc.SocketAttribute.local_address)
        return host, port

    async def _handle(self, stream: anyio.abc.SocketStream) -> None:
        data = await stream.receive()
        self.received.append(data)
        await stream.aclose()

    async def serve_forever(self) -> None:
        assert self._listener is not None
        await self._listener.serve(self._handle)

    async def aclose(self) -> None:
        assert self._listener is not None
        await self._listener.aclose()


@pytest.fixture
async def attacker(monkeypatch):
    """A live local listener, plus the two-answer resolver pointed at it.

    Yields (resolver, attacker) so a test can both trigger the rebinding
    sequence and assert what the attacker actually received.
    """
    victim = _Attacker()
    host, port = await victim.start()
    import asyncio

    serve_task = asyncio.create_task(victim.serve_forever())

    resolver = _TwoAnswerResolver(attacker_addr=(host, port))
    monkeypatch.setattr(socket, "getaddrinfo", resolver)

    yield resolver, victim, port

    serve_task.cancel()
    await victim.aclose()


class TestDnsRebindingToctou:
    @pytest.mark.asyncio
    async def test_PRE_FIX_MECHANISM_the_default_backend_reaches_the_rebound_address(
        self, attacker
    ) -> None:
        """THE VULNERABILITY, DEMONSTRATED, NOT ARGUED.

        `httpcore.AnyIOBackend` is httpx's real, UNMODIFIED default backend
        — exactly what `fetch_and_extract` used before this fix (no
        `transport=` override existed at all). This proves that backend,
        given a hostname whose DNS answer changes between a "validation"
        lookup and its own connect-time lookup, ends up connecting to the
        SECOND answer with no validation in between — the actual bytes are
        exchanged with the attacker's real listener.
        """
        resolver, victim, attacker_port = attacker

        # The "validation" lookup a pre-fix `_resolve_and_check` would have
        # made — consumes the safe answer, same as the real code path.
        first = socket.getaddrinfo(_TwoAnswerResolver.TARGET_HOST, 443)
        assert first[0][4] == _TwoAnswerResolver.SAFE_ANSWER
        assert resolver.calls_for_target == 1

        # httpx's OWN independent resolution at connect time — the second,
        # unrelated lookup #545 describes. This is the unmodified default
        # backend; nothing about it knows or cares what was validated above.
        backend = httpcore.AnyIOBackend()
        stream = await backend.connect_tcp(
            _TwoAnswerResolver.TARGET_HOST, attacker_port, timeout=3.0
        )
        await stream.write(b"GET / HTTP/1.1\r\nHost: rebinding-target.example\r\n\r\n")
        await anyio.sleep(0.1)
        await stream.aclose()

        assert resolver.calls_for_target == 2
        # THE ASSERTION THAT MATTERS: real bytes reached the attacker.
        assert len(victim.received) == 1
        assert b"rebinding-target.example" in victim.received[0]

    @pytest.mark.asyncio
    async def test_the_fix_refuses_the_same_sequence_before_ever_connecting(
        self, attacker
    ) -> None:
        """THE SAME SEQUENCE, THROUGH THE FIX. Zero connections reach the attacker.

        `_SsrfSafeNetworkBackend.connect_tcp` performs its OWN resolution —
        this is the second `getaddrinfo` call in the sequence, exactly where
        the vulnerable test above made its unguarded one — and validates the
        result BEFORE dialing anything. Since that result IS the "rebound"
        (blocked, loopback) address, this must refuse rather than connect.
        """
        resolver, victim, attacker_port = attacker

        first = socket.getaddrinfo(_TwoAnswerResolver.TARGET_HOST, 443)
        assert first[0][4] == _TwoAnswerResolver.SAFE_ANSWER
        assert resolver.calls_for_target == 1

        backend = _SsrfSafeNetworkBackend()
        with pytest.raises(httpcore.ConnectError, match="blocked private/internal"):
            await backend.connect_tcp(
                _TwoAnswerResolver.TARGET_HOST, attacker_port, timeout=3.0
            )

        # This backend's OWN resolution is call #2 — same position in the
        # sequence as the vulnerable test's connect-time lookup.
        assert resolver.calls_for_target == 2
        # THE ASSERTION THAT MATTERS: nothing was ever sent to the attacker.
        await anyio.sleep(0.1)
        assert victim.received == []


class TestRedirectHopSharesTheSameToctouShape:
    """Per-hop re-validation followed by a fresh connect is the identical
    shape as the first request — #545 named this explicitly, and it needed
    checking rather than assuming the fix covers it for free.

    `_SsrfSafeNetworkBackend` is a property of the TRANSPORT, and
    `fetch_and_extract` constructs exactly one transport for the whole
    redirect loop (`async with httpx.AsyncClient(transport=...)`, opened
    once, reused across every hop's `client.send()`) — so every hop's
    connection, not just the first, goes through this same backend's
    `connect_tcp`. Demonstrated directly here by calling `connect_tcp`
    twice against the SAME backend instance, mirroring hop 1 (a normal,
    safe connect) then hop 2 (the rebinding sequence) — proving the second
    call gets the identical protection as the first, not a special case
    that only happens to work once.
    """

    @pytest.mark.asyncio
    async def test_second_hop_through_the_same_backend_instance_is_still_protected(
        self, monkeypatch
    ) -> None:
        """The REAL, live-listener rebinding demonstration is
        `TestDnsRebindingToctou` above — this test's job is narrower and
        deliberately does not repeat it: does the SAME backend instance,
        reused across hops the way `fetch_and_extract`'s single
        `async with httpx.AsyncClient(transport=...)` actually reuses one,
        protect hop 2 identically to hop 1 — or does having already
        connected once leak through and weaken the second call. Mocking
        `_resolve_all_validated` directly, once per hop's hostname, isolates
        exactly that question.
        """
        import anyio.abc as abc
        import asyncio
        import app.services.web_page_fetcher as wpf

        safe_listener = await anyio.create_tcp_listener(local_host="127.0.0.1", local_port=0)
        safe_host, safe_port = safe_listener.extra(abc.SocketAttribute.local_address)

        def fake_resolve(host, port):
            if host == "hop1.example":
                return [safe_host]
            if host == "hop2.example":
                # Mirrors exactly what the REAL _resolve_all_validated does
                # for a blocked-range candidate: refuse before connect_tcp
                # ever dials anything.
                raise FetchError(
                    f"Hostname '{host}' resolves to a blocked private/internal IP address range"
                )
            raise AssertionError(f"unexpected resolve for {host!r}")

        monkeypatch.setattr(wpf, "_resolve_all_validated", fake_resolve)

        accept_task = asyncio.create_task(_accept_once(safe_listener))
        backend = wpf._SsrfSafeNetworkBackend()

        # Hop 1: a normal, safe connect — proves the backend works at all
        # before hop 2, and that reusing it is legitimate in the success case.
        hop1_stream = await backend.connect_tcp("hop1.example", safe_port, timeout=1.5)
        await hop1_stream.aclose()
        await accept_task
        await safe_listener.aclose()

        # Hop 2, SAME backend instance: must be refused exactly as if it
        # were the only request this backend had ever handled.
        with pytest.raises(httpcore.ConnectError, match="blocked private/internal"):
            await backend.connect_tcp("hop2.example", 12345, timeout=1.5)


class TestRoundRobinIsPreserved:
    """The fix must not narrow a legitimately multi-address host to one.

    `connect_tcp` tries EVERY candidate `_resolve_all_validated` hands it,
    in order, falling back on a dead one — the same behaviour an unguarded
    client has. `_resolve_all_validated` itself is mocked here, not
    `socket.getaddrinfo`: real loopback addresses would be blocked by the
    actual blocklist regardless of connectivity, which would test the
    wrong thing (the blocklist, already covered by
    `test_web_page_fetcher.py::TestDnsResolutionBlocking`) instead of the
    fallback LOOP this test exists to prove. Mocking at the
    already-validated boundary isolates exactly that loop.
    """

    @pytest.mark.asyncio
    async def test_a_dead_first_candidate_falls_back_to_a_second_reachable_one(
        self, monkeypatch
    ) -> None:
        import anyio.abc as abc
        import asyncio
        import app.services.web_page_fetcher as wpf

        listener = await anyio.create_tcp_listener(local_host="127.0.0.1", local_port=0)
        _, live_port = listener.extra(abc.SocketAttribute.local_address)

        # connect_tcp dials the SAME port for every candidate it tries — a
        # hostname's multiple A/AAAA records share one target port, only
        # the address varies. So "dead" vs "live" here is two DIFFERENT
        # loopback addresses at the SAME port: 127.0.0.2 (a valid address
        # in the loopback block, nothing listening — refuses fast) tried
        # first, 127.0.0.1 (this test's real listener) second.
        def fake_resolve_all_validated(host, port):
            return ["127.0.0.2", "127.0.0.1"]

        monkeypatch.setattr(wpf, "_resolve_all_validated", fake_resolve_all_validated)

        accept_task = asyncio.create_task(_accept_once(listener))
        backend = wpf._SsrfSafeNetworkBackend()
        try:
            stream = await backend.connect_tcp("multi.example", live_port, timeout=1.5)
            await stream.aclose()
            reached_live = True
        except httpcore.ConnectError:
            reached_live = False
        finally:
            accept_task.cancel()
            await listener.aclose()

        assert reached_live, "a live second candidate must still be reachable after a dead first one"


async def _accept_once(listener: "anyio.abc.SocketListener") -> None:
    connected = anyio.Event()

    async def handle(stream: anyio.abc.SocketStream) -> None:
        await stream.aclose()
        connected.set()

    async with anyio.create_task_group() as tg:
        tg.start_soon(listener.serve, handle)
        # serve() runs forever; cancel the group once one connection lands.
        await connected.wait()
        tg.cancel_scope.cancel()
