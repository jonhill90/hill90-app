"""Unit tests for web page fetcher with SSRF protection.

Tests cover the full Fetch Safety Contract:
- URL validation (scheme, credentials, port, internal hostnames)
- DNS resolution check against blocked CIDR ranges
- Redirect re-validation on every hop
- Error message information leak prevention
- Response size limits (Content-Length header + streaming body enforcement)
- Non-2xx HTTP status rejected before extraction (#437)
"""

from __future__ import annotations

import socket
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.services.web_page_fetcher import (
    FetchError,
    MAX_RESPONSE_BYTES,
    MAX_TITLE_LENGTH,
    _is_blocked_ip,
    _validate_url,
    fetch_and_extract,
)


# ---------------------------------------------------------------------------
# Helper: build mock streaming client + response
# ---------------------------------------------------------------------------


def _make_streaming_response(
    *,
    status_code: int = 200,
    headers: dict[str, str] | None = None,
    body: bytes = b"",
    is_redirect: bool = False,
    charset_encoding: str | None = "utf-8",
) -> MagicMock:
    """Build a mock httpx response compatible with streaming (send + aiter_bytes)."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.is_redirect = is_redirect
    resp.headers = headers or {}
    resp.charset_encoding = charset_encoding
    resp.aclose = AsyncMock()

    # Create an async generator for aiter_bytes
    _body = body

    async def _aiter_bytes(chunk_size: int = 65536):
        for i in range(0, len(_body), chunk_size):
            yield _body[i : i + chunk_size]

    resp.aiter_bytes = _aiter_bytes
    return resp


def _make_mock_client(response: MagicMock | Exception) -> AsyncMock:
    """Build a mock httpx.AsyncClient with send + build_request."""
    mock_client = AsyncMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.build_request = MagicMock(return_value=MagicMock())

    if isinstance(response, Exception):
        mock_client.send = AsyncMock(side_effect=response)
    else:
        mock_client.send = AsyncMock(return_value=response)

    return mock_client


# DNS mock that returns a public IP (passes all checks)
PUBLIC_DNS = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 443))]


# ---------------------------------------------------------------------------
# URL Validation — scheme, credentials, port, hostnames
# ---------------------------------------------------------------------------


class TestValidateUrl:
    def test_accepts_https_url(self) -> None:
        _validate_url("https://example.com/page")

    def test_accepts_http_url(self) -> None:
        _validate_url("http://example.com/page")

    def test_rejects_ftp_scheme(self) -> None:
        with pytest.raises(FetchError, match="scheme"):
            _validate_url("ftp://example.com/file.txt")

    def test_rejects_file_scheme(self) -> None:
        with pytest.raises(FetchError, match="scheme"):
            _validate_url("file:///etc/passwd")

    def test_rejects_data_scheme(self) -> None:
        with pytest.raises(FetchError, match="scheme"):
            _validate_url("data:text/html,<h1>hi</h1>")

    def test_rejects_javascript_scheme(self) -> None:
        with pytest.raises(FetchError, match="scheme"):
            _validate_url("javascript:alert(1)")

    def test_rejects_url_with_userinfo(self) -> None:
        with pytest.raises(FetchError, match="credentials"):
            _validate_url("https://user:pass@example.com/")

    def test_rejects_url_with_username_only(self) -> None:
        with pytest.raises(FetchError, match="credentials"):
            _validate_url("https://admin@example.com/")

    def test_rejects_non_standard_port(self) -> None:
        with pytest.raises(FetchError, match="port"):
            _validate_url("https://example.com:8080/page")

    def test_accepts_port_80(self) -> None:
        _validate_url("http://example.com:80/page")

    def test_accepts_port_443(self) -> None:
        _validate_url("https://example.com:443/page")

    def test_rejects_empty_hostname(self) -> None:
        with pytest.raises(FetchError, match="hostname"):
            _validate_url("https:///path")

    def test_rejects_internal_service_hostname_postgres(self) -> None:
        with pytest.raises(FetchError, match="internal service"):
            _validate_url("http://postgres:5432/")

    def test_rejects_internal_service_hostname_api(self) -> None:
        with pytest.raises(FetchError, match="internal service"):
            _validate_url("http://api/health")

    def test_rejects_internal_service_hostname_keycloak(self) -> None:
        with pytest.raises(FetchError, match="internal service"):
            _validate_url("http://keycloak:8080/auth")

    def test_rejects_internal_service_hostname_litellm(self) -> None:
        with pytest.raises(FetchError, match="internal service"):
            _validate_url("http://litellm/v1/models")

    def test_rejects_internal_service_hostname_openbao(self) -> None:
        with pytest.raises(FetchError, match="internal service"):
            _validate_url("http://openbao:8200/v1/sys/health")

    def test_rejects_internal_service_hostname_knowledge(self) -> None:
        with pytest.raises(FetchError, match="internal service"):
            _validate_url("http://knowledge:8002/health")

    def test_rejects_ip_literal_loopback(self) -> None:
        with pytest.raises(FetchError, match="blocked"):
            _validate_url("http://127.0.0.1/")

    def test_rejects_ip_literal_private(self) -> None:
        with pytest.raises(FetchError, match="blocked"):
            _validate_url("http://10.0.0.1/")


# ---------------------------------------------------------------------------
# Blocked IP ranges — all 7 CIDR categories
# ---------------------------------------------------------------------------


class TestIsBlockedIp:
    def test_blocks_loopback_127(self) -> None:
        assert _is_blocked_ip("127.0.0.1") is True
        assert _is_blocked_ip("127.255.255.255") is True

    def test_blocks_rfc1918_class_a(self) -> None:
        assert _is_blocked_ip("10.0.0.1") is True
        assert _is_blocked_ip("10.255.255.255") is True

    def test_blocks_rfc1918_class_b_docker(self) -> None:
        assert _is_blocked_ip("172.16.0.1") is True
        assert _is_blocked_ip("172.31.255.255") is True
        # 172.32.x should NOT be blocked
        assert _is_blocked_ip("172.32.0.1") is False

    def test_blocks_rfc1918_class_c(self) -> None:
        assert _is_blocked_ip("192.168.0.1") is True
        assert _is_blocked_ip("192.168.255.255") is True

    def test_blocks_link_local(self) -> None:
        assert _is_blocked_ip("169.254.0.1") is True
        assert _is_blocked_ip("169.254.169.254") is True  # AWS metadata

    def test_blocks_tailscale_cgnat(self) -> None:
        assert _is_blocked_ip("100.64.0.1") is True
        assert _is_blocked_ip("100.100.100.100") is True
        assert _is_blocked_ip("100.127.255.255") is True

    def test_blocks_unspecified(self) -> None:
        assert _is_blocked_ip("0.0.0.0") is True

    def test_blocks_broadcast(self) -> None:
        assert _is_blocked_ip("255.255.255.255") is True

    def test_blocks_reserved(self) -> None:
        """`addr.is_reserved`. IPv4 addresses in the Class E block
        (240.0.0.0/4) are the obvious example, but in this Python version
        `is_private` is already True for the entire block — so an IPv4-only
        test here would pass even with the `is_reserved` branch deleted,
        proven by removing it and finding those addresses still blocked via
        `is_private`. `64:ff9b::1` (the well-known NAT64 prefix, RFC 6052)
        is reserved but NOT private, which genuinely isolates this branch —
        confirmed by removing `is_reserved` from _is_blocked_ip and seeing
        only this assertion fail, not the IPv4 one below."""
        assert _is_blocked_ip("64:ff9b::1") is True
        assert _is_blocked_ip("240.0.0.1") is True  # blocked, but via is_private, not this branch

    def test_blocks_multicast(self) -> None:
        """`addr.is_multicast` — IPv4 224.0.0.0/4 and its IPv6 equivalent.
        Same unexercised-branch shape as is_reserved above: removing this
        check left the full suite green with nothing added."""
        assert _is_blocked_ip("224.0.0.1") is True
        assert _is_blocked_ip("239.255.255.255") is True
        assert _is_blocked_ip("ff02::1") is True

    def test_allows_public_ip(self) -> None:
        assert _is_blocked_ip("8.8.8.8") is False
        assert _is_blocked_ip("1.1.1.1") is False
        assert _is_blocked_ip("93.184.216.34") is False  # example.com

    def test_blocks_ipv6_loopback(self) -> None:
        assert _is_blocked_ip("::1") is True

    def test_blocks_ipv6_link_local(self) -> None:
        assert _is_blocked_ip("fe80::1") is True

    def test_blocks_ipv6_unique_local(self) -> None:
        assert _is_blocked_ip("fc00::1") is True
        assert _is_blocked_ip("fd00::1") is True


# ---------------------------------------------------------------------------
# DNS resolution → blocked IP detection
# ---------------------------------------------------------------------------


class TestDnsResolutionBlocking:
    @pytest.mark.asyncio
    async def test_blocks_dns_resolving_to_private_ip(self) -> None:
        """A public hostname that resolves to a private IP must be rejected."""
        with patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [
                (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.0.0.5", 80))
            ]
            with pytest.raises(FetchError, match="blocked"):
                await fetch_and_extract("https://evil.example.com/page")

    @pytest.mark.asyncio
    async def test_blocks_dns_resolving_to_loopback(self) -> None:
        with patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [
                (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", 80))
            ]
            with pytest.raises(FetchError, match="blocked"):
                await fetch_and_extract("https://evil.example.com/page")


# ---------------------------------------------------------------------------
# Redirect re-validation
# ---------------------------------------------------------------------------


class TestRedirectRevalidation:
    @pytest.mark.asyncio
    async def test_blocks_redirect_to_private_ip(self) -> None:
        """Redirect to http://127.0.0.1/ must be caught and rejected."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            redirect_resp = _make_streaming_response(
                status_code=301,
                headers={"location": "http://127.0.0.1/secret"},
                is_redirect=True,
            )
            mock_client_cls.return_value = _make_mock_client(redirect_resp)

            with pytest.raises(FetchError, match="blocked|internal"):
                await fetch_and_extract("https://redirect.example.com/go")

    @pytest.mark.asyncio
    async def test_blocks_redirect_to_private_ip_on_SECOND_hop_not_just_first(self) -> None:
        """A chain where hop 1 is SAFE and hop 2 targets a blocked address
        must still be caught. The test above only proves the block fires
        when the blocked address is the very first redirect target; it
        cannot distinguish "re-validates every hop" from "only checks hop
        1" because it has no hop 2.

        Hop 2's redirect target is a HOSTNAME that resolves (via mocked
        DNS) to a private IP — not an IP literal — because `_validate_url`
        independently blocks IP literals like `http://127.0.0.1/...` on
        its own, before `_resolve_and_check` ever runs. An earlier version
        of this test used an IP-literal hop-2 target and passed even after
        mutating the redirect loop to skip re-validation past hop 1 —
        `_validate_url`'s unmutated IP-literal check was silently covering
        for the mutated code, and the test proved nothing about per-hop
        DNS re-validation. Using a hostname closes that gap: verified by
        mutating the source to `if redirects == 1:` around the
        `_resolve_and_check` call — this test then failed (the fetch
        proceeded to a third hop and returned 200 instead of raising),
        and the three other redirect tests in this class stayed green
        against that same mutation, because none of them has a blocked
        target past hop 1 either."""

        def dns_side_effect(hostname, *args, **kwargs):
            if hostname == "internal-service.example.com":
                return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.0.0.5", 443))]
            return PUBLIC_DNS

        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.side_effect = dns_side_effect

            hop1_redirect = _make_streaming_response(
                status_code=302,
                headers={"location": "https://safe-hop.example.com/next"},
                is_redirect=True,
            )
            hop2_redirect_to_blocked = _make_streaming_response(
                status_code=302,
                headers={"location": "http://internal-service.example.com/secret"},
                is_redirect=True,
            )
            # Only reached if the mutation lets hop 2 through unchecked —
            # gives the mutated run a clean "fetch succeeded" failure mode
            # instead of an unrelated mock-exhaustion error.
            hop3_leaked_content = _make_streaming_response(
                status_code=200,
                headers={"content-type": "text/html"},
                body=b"<html><body>leaked</body></html>",
            )

            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_client.build_request = MagicMock(return_value=MagicMock())
            mock_client.send = AsyncMock(
                side_effect=[hop1_redirect, hop2_redirect_to_blocked, hop3_leaked_content]
            )
            mock_client_cls.return_value = mock_client

            with pytest.raises(FetchError, match="blocked|internal"):
                await fetch_and_extract("https://redirect.example.com/go")

            # Only the first two hops should have been attempted — proves
            # the rejection happened AT hop 2, not because hop 1 itself
            # failed, and not because the fetch ran to completion.
            assert mock_client.send.call_count == 2

    @pytest.mark.asyncio
    async def test_redirect_revalidates_scheme(self) -> None:
        """Redirect to ftp:// must be rejected."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            redirect_resp = _make_streaming_response(
                status_code=302,
                headers={"location": "ftp://files.example.com/data"},
                is_redirect=True,
            )
            mock_client_cls.return_value = _make_mock_client(redirect_resp)

            with pytest.raises(FetchError, match="scheme"):
                await fetch_and_extract("https://redirect.example.com/go")

    @pytest.mark.asyncio
    async def test_max_redirects_enforced(self) -> None:
        """More than 3 redirects must be rejected."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            redirect_resp = _make_streaming_response(
                status_code=302,
                headers={"location": "https://example.com/next"},
                is_redirect=True,
            )
            mock_client_cls.return_value = _make_mock_client(redirect_resp)

            with pytest.raises(FetchError, match="redirect"):
                await fetch_and_extract("https://loop.example.com/start")


# ---------------------------------------------------------------------------
# Error message information leak prevention
# ---------------------------------------------------------------------------


class TestErrorMessageNoIpLeak:
    @pytest.mark.asyncio
    async def test_error_message_no_ip_leak(self) -> None:
        """Error messages must not include the resolved IP address."""
        with patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [
                (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.42.99.7", 80))
            ]
            with pytest.raises(FetchError) as exc_info:
                await fetch_and_extract("https://sneaky.example.com/data")

            error_msg = str(exc_info.value)
            assert "10.42.99.7" not in error_msg
            assert "blocked" in error_msg.lower() or "private" in error_msg.lower()


# ---------------------------------------------------------------------------
# Response size limit — Content-Length header + streaming enforcement
# ---------------------------------------------------------------------------


class TestResponseSizeLimit:
    @pytest.mark.asyncio
    async def test_rejects_oversized_content_length_header(self) -> None:
        """Response with Content-Length > 2MB must be rejected before reading body."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            resp = _make_streaming_response(
                headers={
                    "content-length": str(3 * 1024 * 1024),
                    "content-type": "text/html",
                },
            )
            mock_client = _make_mock_client(resp)
            mock_client_cls.return_value = mock_client

            with pytest.raises(FetchError, match="size"):
                await fetch_and_extract("https://big.example.com/huge-page")

            # aclose must be called even on rejection
            resp.aclose.assert_called()

    @pytest.mark.asyncio
    async def test_rejects_oversized_body_without_content_length(self) -> None:
        """Response without Content-Length that exceeds 2MB during streaming must be rejected."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            # No content-length header — server streams without advertising size
            oversized_body = b"x" * (MAX_RESPONSE_BYTES + 1)
            resp = _make_streaming_response(
                headers={"content-type": "text/html"},
                body=oversized_body,
            )
            mock_client_cls.return_value = _make_mock_client(resp)

            with pytest.raises(FetchError, match="size limit"):
                await fetch_and_extract("https://big.example.com/no-content-length")

            # aclose must be called via finally block
            resp.aclose.assert_called()

    @pytest.mark.asyncio
    async def test_streaming_aborts_mid_read(self) -> None:
        """Body exceeding 2MB is rejected during streaming, not after full buffering."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            # Build a response that yields many 64KB chunks exceeding the limit
            chunk_count = (MAX_RESPONSE_BYTES // 65536) + 2  # enough to exceed limit
            chunks_yielded: list[int] = []

            async def _tracked_aiter_bytes(chunk_size: int = 65536):
                for i in range(chunk_count):
                    chunks_yielded.append(i)
                    yield b"x" * 65536

            resp = MagicMock()
            resp.status_code = 200
            resp.is_redirect = False
            resp.headers = {"content-type": "text/html"}
            resp.charset_encoding = "utf-8"
            resp.aclose = AsyncMock()
            resp.aiter_bytes = _tracked_aiter_bytes

            mock_client_cls.return_value = _make_mock_client(resp)

            with pytest.raises(FetchError, match="size limit"):
                await fetch_and_extract("https://big.example.com/streaming")

            # Verify streaming aborted before all chunks were read
            assert len(chunks_yielded) < chunk_count


# ---------------------------------------------------------------------------
# Successful fetch and extract
# ---------------------------------------------------------------------------


class TestFetchAndExtract:
    @pytest.mark.asyncio
    async def test_web_page_fetcher_extracts_content(self) -> None:
        """Successful fetch returns title and extracted text."""
        html = "<html><head><title>Test Page</title></head><body><p>Hello world paragraph.</p></body></html>"
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
            patch("app.services.web_page_fetcher.trafilatura") as mock_traf,
        ):
            mock_dns.return_value = PUBLIC_DNS

            resp = _make_streaming_response(
                headers={"content-length": "200", "content-type": "text/html"},
                body=html.encode(),
            )
            mock_client_cls.return_value = _make_mock_client(resp)

            mock_traf.extract.return_value = "Hello world paragraph."
            mock_traf.extract_metadata.return_value = MagicMock(title="Test Page")

            result = await fetch_and_extract("https://example.com/page")

            assert result["content"] == "Hello world paragraph."
            assert result["url"] == "https://example.com/page"
            # The docstring promised a title and this assertion was missing, which
            # is how the fetcher shipped returning the hostname for every page.
            assert result["title"] == "Test Page"

    # THE ASSERTION THAT MATTERS. The docstring's own "Fetch Safety Contract"
    # lists URL validation, DNS/CIDR checks, redirect re-validation, error
    # message leak prevention, and response size limits — status_code is not
    # in that list, and nothing in fetch_and_extract ever reads it outside the
    # `is_redirect` branch. A 404 or 500 page frequently HAS extractable text
    # ("404 Not Found — the page you requested does not exist") — trafilatura
    # does not know or care that the surrounding response was an error, so
    # that text passes the "not empty" check a few lines later and is ingested
    # as if it were the page the caller asked for. ingest.py then marks the
    # job completed and the source active: a source row that exists, with
    # real chunks, that are not the content anyone asked to ingest.
    @pytest.mark.asyncio
    async def test_error_status_with_extractable_body_is_not_ingested_as_content(self) -> None:
        """A 404/500 response must fail the fetch, even if its body has text."""
        html = "<html><body><h1>404 Not Found</h1><p>The page you requested does not exist.</p></body></html>"
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
            patch("app.services.web_page_fetcher.trafilatura") as mock_traf,
        ):
            mock_dns.return_value = PUBLIC_DNS
            resp = _make_streaming_response(
                status_code=404,
                headers={"content-type": "text/html"},
                body=html.encode(),
            )
            mock_client_cls.return_value = _make_mock_client(resp)
            # A real extractor WOULD pull text out of this — that's the point.
            mock_traf.extract.return_value = "404 Not Found The page you requested does not exist."

            with pytest.raises(FetchError, match="404"):
                await fetch_and_extract("https://example.com/gone")

            mock_traf.extract.assert_not_called()

    @pytest.mark.asyncio
    async def test_server_error_status_is_also_rejected(self) -> None:
        """POSITIVE CONTROL for the check being about the STATUS, not this one code."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
            patch("app.services.web_page_fetcher.trafilatura"),
        ):
            mock_dns.return_value = PUBLIC_DNS
            resp = _make_streaming_response(
                status_code=503,
                headers={"content-type": "text/html"},
                body=b"<html><body>Service Unavailable</body></html>",
            )
            mock_client_cls.return_value = _make_mock_client(resp)

            with pytest.raises(FetchError, match="503"):
                await fetch_and_extract("https://example.com/down")

    async def _fetch_with_metadata(self, metadata: object) -> dict:
        """Run a successful fetch with trafilatura's metadata mocked."""
        html = "<html><head><title>ignored, trafilatura is mocked</title></head><body><p>Body.</p></body></html>"
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
            patch("app.services.web_page_fetcher.trafilatura") as mock_traf,
        ):
            mock_dns.return_value = PUBLIC_DNS
            resp = _make_streaming_response(
                headers={"content-length": "200", "content-type": "text/html"},
                body=html.encode(),
            )
            mock_client_cls.return_value = _make_mock_client(resp)
            mock_traf.extract.return_value = "Body."
            if isinstance(metadata, Exception):
                mock_traf.extract_metadata.side_effect = metadata
            else:
                mock_traf.extract_metadata.return_value = metadata
            return await fetch_and_extract("https://example.com/page")

    @pytest.mark.asyncio
    async def test_title_comes_from_page_metadata(self) -> None:
        """THE REGRESSION TEST. The title must be the page's, not the hostname.

        The fetcher used to call trafilatura with output_format="xmltei" and never
        read the result, so this returned "example.com" for every page ingested.
        ingest.py adopts this value whenever the caller supplied no title, so the
        wrong answer reached stored, user-visible content.
        """
        result = await self._fetch_with_metadata(MagicMock(title="What is Azure DevOps?"))
        assert result["title"] == "What is Azure DevOps?"
        assert result["title"] != "example.com"

    @pytest.mark.asyncio
    async def test_title_falls_back_to_hostname_when_page_has_none(self) -> None:
        """A page with no usable title still gets a sensible one."""
        assert (await self._fetch_with_metadata(MagicMock(title=None)))["title"] == "example.com"
        assert (await self._fetch_with_metadata(MagicMock(title="   ")))["title"] == "example.com"
        assert (await self._fetch_with_metadata(None))["title"] == "example.com"

    @pytest.mark.asyncio
    async def test_long_title_is_truncated_to_the_column_width(self) -> None:
        """shared_sources.title and shared_documents.title are varchar(512).

        Without the cap, a page with a longer <title> turns a successful fetch
        into a database error at insert — a worse failure than a shortened title.
        """
        result = await self._fetch_with_metadata(MagicMock(title="T" * 900))
        assert len(result["title"]) == MAX_TITLE_LENGTH == 512

    @pytest.mark.asyncio
    async def test_metadata_failure_does_not_fail_the_fetch(self) -> None:
        """Content extracted cleanly; a metadata parse error must not lose it."""
        result = await self._fetch_with_metadata(ValueError("malformed"))
        assert result["content"] == "Body."
        assert result["title"] == "example.com"

    @pytest.mark.asyncio
    async def test_web_page_fetcher_timeout(self) -> None:
        """Connection timeout raises FetchError."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
        ):
            mock_dns.return_value = PUBLIC_DNS

            mock_client_cls.return_value = _make_mock_client(
                httpx.ConnectTimeout("timed out")
            )

            with pytest.raises(FetchError, match="timed out|timeout"):
                await fetch_and_extract("https://slow.example.com/page")

    @pytest.mark.asyncio
    async def test_web_page_fetcher_extraction_fails(self) -> None:
        """When trafilatura returns None, raise FetchError."""
        with (
            patch("app.services.web_page_fetcher.socket.getaddrinfo") as mock_dns,
            patch("app.services.web_page_fetcher.httpx.AsyncClient") as mock_client_cls,
            patch("app.services.web_page_fetcher.trafilatura") as mock_traf,
        ):
            mock_dns.return_value = PUBLIC_DNS

            resp = _make_streaming_response(
                headers={"content-length": "200", "content-type": "text/html"},
                body=b"<html></html>",
            )
            mock_client_cls.return_value = _make_mock_client(resp)

            mock_traf.extract.return_value = None

            with pytest.raises(FetchError, match="extract"):
                await fetch_and_extract("https://empty.example.com/page")
