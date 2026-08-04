import { auth } from '@/auth'
import { NextResponse } from 'next/server'
import { nonJsonUpstreamResponse } from '@/utils/api-proxy'
import {
  readUpstreamTextLimited,
  upstreamTooLargeResponse,
  UpstreamTooLargeError,
} from '@/utils/request-body'

const API_URL = process.env.API_URL || 'http://localhost:3000'

export async function GET() {
  const session = await auth()
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  if (!session.user?.roles?.includes('admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const res = await fetch(`${API_URL}/openapi.json`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      signal: AbortSignal.timeout(30000),
    })
    let raw: string
    try {
      raw = await readUpstreamTextLimited(res)
    } catch (err) {
      if (err instanceof UpstreamTooLargeError) return upstreamTooLargeResponse(err)
      throw err
    }
    // #223
    let data: unknown
    try {
      data = raw === '' ? null : JSON.parse(raw)
    } catch {
      return nonJsonUpstreamResponse('openapi-proxy', res.status, raw)
    }
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    console.error('[docs-proxy] Error:', err)
    return NextResponse.json({ error: 'API request failed' }, { status: 502 })
  }
}
