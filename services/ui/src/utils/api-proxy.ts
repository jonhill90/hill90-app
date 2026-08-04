import { auth } from '@/auth'
import { NextRequest, NextResponse } from 'next/server'
import {
  readTextLimited,
  readUpstreamTextLimited,
  bodyTooLargeResponse,
  upstreamTooLargeResponse,
  BodyTooLargeError,
  UpstreamTooLargeError,
  BODY_LIMIT_JSON,
} from '@/utils/request-body'

const API_URL = process.env.API_URL || 'http://localhost:3000'

/**
 * What to answer when the upstream body is not JSON (#223).
 *
 * THE DEFECT this replaces: `JSON.parse` sat inside the same `try` as the
 * `fetch`, so a body that is not JSON landed in the same `catch` as a
 * connection failure and the caller got `502 {"error":"API request failed"}`.
 * The upstream status was gone and the upstream message was gone. The api has
 * no 404 handler, so an unmatched path falls through to Express's default HTML
 * — measured as `404 text/html` — and every `[...path]` proxy turned that into
 * a 502. A browser devtools tab then shows a plausible-looking wrong cause,
 * which is the family this repository has spent the day removing: the specific
 * truth was available and thrown away.
 *
 * WHAT IS SURFACED, AND WHAT IS NOT — the boundary is the point.
 *
 *   - The STATUS is surfaced, because that is the discarded fact that matters
 *     and a status code discloses nothing: a 404 arrives as a 404.
 *   - The upstream BODY is NOT surfaced. The consumer here is a browser, and an
 *     upstream body can carry a stack trace, an internal hostname, or a token
 *     echoed back in an error. A 502 that quotes an internal stack trace is a
 *     different defect from the one being fixed, so the body goes to the server
 *     log — truncated, where the cause lives — and the response carries the
 *     fact and the number instead.
 *
 * A NON-JSON body under a 2xx is NOT forwarded as that 2xx: a success status
 * whose body is an error envelope is the shape #260 was about. That is an
 * upstream contract violation, and 502 Bad Gateway is its literal meaning.
 */
export function nonJsonUpstreamResponse(
  label: string,
  upstreamStatus: number,
  body: string,
): NextResponse {
  console.error(
    `[${label}] upstream returned non-JSON (HTTP ${upstreamStatus}):`,
    body.slice(0, 500),
  )
  return NextResponse.json(
    { error: 'Upstream returned a non-JSON response', upstream_status: upstreamStatus },
    { status: upstreamStatus >= 400 ? upstreamStatus : 502, headers: NO_SHARED_CACHE },
  )
}

/**
 * Proxy a Next.js API route request to the backend API service.
 * Handles auth, query params, body forwarding, and SSE passthrough.
 *
 * Every response here is built from the CALLER'S access token, so it varies by
 * session and no shared cache may store it. Nothing set a Cache-Control before,
 * and RFC 9111 lets an intermediary heuristically cache a 200 that carries no
 * freshness information — the milder form of the `public, max-age=10` that
 * /api/services/health was serving (#134).
 */
const NO_SHARED_CACHE = { 'Cache-Control': 'private, no-store' } as const

/**
 * Upstream response headers this proxy forwards to the browser.
 *
 * An allowlist, not a copy of everything. `content-length` and
 * `content-encoding` describe the upstream body, which this proxy re-serialises
 * — forwarding them would describe the wrong bytes. `set-cookie` from the API
 * has no business reaching the browser through here.
 *
 * This function exists because the proxy silently dropped `X-Total-Count`.
 * Knowledge set it, the api forwarded it, and it died on this hop — so the UI
 * could not tell a complete list from a truncated one (#180).
 */
const FORWARDED_HEADERS = ['x-total-count'] as const

/**
 * Exported so hand-rolled proxies use the SAME list rather than each keeping a
 * copy. A header added here must reach every hop; a second copy is a header that
 * reaches one of them, which is how `x-total-count` came to be forwarded by this
 * helper and dropped by the agents route.
 */
export function passThroughHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of FORWARDED_HEADERS) {
    const value = res.headers.get(name)
    if (value !== null) out[name] = value
  }
  return out
}

export async function proxyToApi(
  req: NextRequest,
  backendPath: string,
  { label = 'proxy', sse = false }: { label?: string; sse?: boolean } = {}
) {
  const session = await auth()
  if (!session?.accessToken) {
    // The refusal needs the header in its own right: a cached 401 would be
    // served to a signed-in user, and a cached 200 to an anonymous one.
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 401, headers: NO_SHARED_CACHE },
    )
  }

  const url = new URL(`${API_URL}${backendPath}`)

  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value)
  })

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${session.accessToken}`,
  }

  const contentType = req.headers.get('content-type')
  if (contentType) {
    headers['Content-Type'] = contentType
  }

  // SSE streaming routes — no timeout for long-lived streams
  const isSSE = sse || req.nextUrl.searchParams.get('follow') === 'true'

  const fetchOpts: RequestInit = {
    method: req.method,
    headers,
    ...(isSSE ? {} : { signal: AbortSignal.timeout(30000) }),
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Counted, not just declared. Nothing here set any body limit, so a signed-in
    // caller could make this process allocate an unbounded buffer before the API
    // — which caps JSON at express's 100kb — ever saw the request.
    try {
      fetchOpts.body = await readTextLimited(req, BODY_LIMIT_JSON)
    } catch (err) {
      if (err instanceof BodyTooLargeError) return bodyTooLargeResponse(err)
      throw err
    }
  }

  try {
    const res = await fetch(url.toString(), fetchOpts)

    // SSE: pass the stream through without JSON parsing
    const resContentType = res.headers.get('content-type') || ''
    if (resContentType.includes('text/event-stream')) {
      return new Response(res.body, {
        status: res.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    }

    // Counted, like the request half. `res.json()` buffered whatever the API
    // sent, and the listings behind some of these routes carry no SQL LIMIT.
    let raw: string
    try {
      raw = await readUpstreamTextLimited(res)
    } catch (err) {
      if (err instanceof UpstreamTooLargeError) return upstreamTooLargeResponse(err)
      throw err
    }
    // OUTSIDE the try that wraps the fetch: an unparseable body is an answer
    // from the upstream, not a failure to reach it, and the two must not share
    // a catch (#223).
    let data: unknown
    try {
      data = raw === '' ? null : JSON.parse(raw)
    } catch {
      return nonJsonUpstreamResponse(label, res.status, raw)
    }
    return NextResponse.json(data, {
      status: res.status,
      headers: { ...NO_SHARED_CACHE, ...passThroughHeaders(res) },
    })
  } catch (err) {
    console.error(`[${label}] Error:`, err)
    return NextResponse.json(
      { error: 'API request failed' },
      { status: 502, headers: NO_SHARED_CACHE },
    )
  }
}
