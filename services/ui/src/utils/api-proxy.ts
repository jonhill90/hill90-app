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
    const data = raw === '' ? null : JSON.parse(raw)
    return NextResponse.json(data, { status: res.status, headers: NO_SHARED_CACHE })
  } catch (err) {
    console.error(`[${label}] Error:`, err)
    return NextResponse.json(
      { error: 'API request failed' },
      { status: 502, headers: NO_SHARED_CACHE },
    )
  }
}
