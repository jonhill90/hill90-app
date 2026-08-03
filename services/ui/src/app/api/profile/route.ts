import { auth } from '@/auth'
import { NextRequest, NextResponse } from 'next/server'
import {
  readTextLimited,
  bodyTooLargeResponse,
  BodyTooLargeError,
  BODY_LIMIT_JSON,
  readUpstreamTextLimited,
  upstreamTooLargeResponse,
  UpstreamTooLargeError,
} from '@/utils/request-body'

const API_URL = process.env.API_URL || 'http://localhost:3000'

async function proxyRequest(req: NextRequest) {
  const session = await auth()
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const url = new URL(`${API_URL}/profile`)

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${session.accessToken}`,
  }

  const contentType = req.headers.get('content-type')
  if (contentType) {
    headers['Content-Type'] = contentType
  }

  const fetchOpts: RequestInit = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(30000),
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      fetchOpts.body = await readTextLimited(req, BODY_LIMIT_JSON)
    } catch (err) {
      if (err instanceof BodyTooLargeError) return bodyTooLargeResponse(err)
      throw err
    }
  }

  try {
    const res = await fetch(url.toString(), fetchOpts)
    let raw: string
    try {
      raw = await readUpstreamTextLimited(res)
    } catch (err) {
      if (err instanceof UpstreamTooLargeError) return upstreamTooLargeResponse(err)
      throw err
    }
    const data = raw === '' ? null : JSON.parse(raw)
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    console.error('[profile-proxy] Error:', err)
    return NextResponse.json({ error: 'API request failed' }, { status: 502 })
  }
}

export const GET = proxyRequest
export const PATCH = proxyRequest
