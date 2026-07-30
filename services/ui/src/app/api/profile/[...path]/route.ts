import { auth } from '@/auth'
import { NextRequest, NextResponse } from 'next/server'

const API_URL = process.env.API_URL || 'http://localhost:3000'

async function proxyRequest(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const session = await auth()
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { path } = await params
  const pathStr = path.join('/')
  const url = new URL(`${API_URL}/profile/${pathStr}`)

  // Forward query params
  req.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value)
  })

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${session.accessToken}`,
  }

  const contentType = req.headers.get('content-type')

  // For multipart (avatar upload), forward raw body and content-type header
  // For JSON requests, forward content-type normally
  if (contentType) {
    headers['Content-Type'] = contentType
  }

  // Forward conditional request headers for ETag/304 support
  const ifNoneMatch = req.headers.get('if-none-match')
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch
  const ifModifiedSince = req.headers.get('if-modified-since')
  if (ifModifiedSince) headers['If-Modified-Since'] = ifModifiedSince

  const fetchOpts: RequestInit = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(30000),
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Forward raw body bytes (works for both multipart and JSON)
    fetchOpts.body = await req.arrayBuffer()
    // duplex required for streaming request bodies in Node fetch
    ;(fetchOpts as any).duplex = 'half'
  }

  try {
    const res = await fetch(url.toString(), fetchOpts)

    // Binary response (avatar image) — stream through
    const resContentType = res.headers.get('content-type') || ''
    if (resContentType.startsWith('image/')) {
      const responseHeaders: Record<string, string> = {
        'Content-Type': resContentType,
        'Cache-Control': res.headers.get('cache-control') || 'private, no-cache',
      }
      const etag = res.headers.get('etag')
      if (etag) responseHeaders['ETag'] = etag

      return new Response(res.body, {
        status: res.status,
        headers: responseHeaders,
      })
    }

    // 304 Not Modified has no body
    if (res.status === 304) {
      return new Response(null, { status: 304 })
    }

    // Read as text first. `res.json()` was called unconditionally here, and any
    // bodiless response threw `SyntaxError: Unexpected end of JSON input` — caught
    // below and reported as 502, with the real cause only in the log.
    //
    // That went live when GET /profile/avatar started answering 204 for "this user has
    // no avatar" (#32). Measured in production: three consecutive logins, three 502s,
    // and four of those log lines per page load. It stayed invisible because
    // AuthButtons treats any non-ok response as "no avatar", so a 502 and a 204 look
    // identical to the user. 204 with no body is a correct response; parsing it was
    // the bug.
    const text = await res.text()
    if (!text) {
      return new Response(null, { status: res.status })
    }

    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      // A non-empty body that is not JSON IS a fault, and must still surface — this
      // guard must not become "ignore all parse failures". Name what came back
      // instead of letting a parser's complaint stand in for the cause.
      console.error(
        `[profile-proxy] upstream returned non-JSON (HTTP ${res.status}):`,
        text.slice(0, 200),
      )
      return NextResponse.json(
        { error: 'API request failed', upstream_status: res.status },
        { status: 502 },
      )
    }
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    console.error('[profile-proxy] Error:', err)
    return NextResponse.json({ error: 'API request failed' }, { status: 502 })
  }
}

export const GET = proxyRequest
export const POST = proxyRequest
export const DELETE = proxyRequest
