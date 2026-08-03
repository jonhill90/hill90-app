import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/auth'
import { proxyToApi } from '@/utils/api-proxy'
import {
  readBodyLimited,
  bodyTooLargeResponse,
  BodyTooLargeError,
  BODY_LIMIT_UPLOAD,
  readUpstreamTextLimited,
  upstreamTooLargeResponse,
  UpstreamTooLargeError,
} from '@/utils/request-body'

const API_URL = process.env.API_URL || 'http://localhost:3000'

// This route does NOT go through proxyToApi — it streams the multipart body
// itself — so it needs its own copy of the header the helper applies.
const NO_SHARED_CACHE = { 'Cache-Control': 'private, no-store' } as const

async function proxyRequest(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const pathStr = path.join('/')
  return proxyToApi(req, `/storage/${pathStr}`, { label: 'storage-proxy' })
}

async function proxyUpload(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const session = await auth()
  if (!session?.accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401, headers: NO_SHARED_CACHE })
  }

  const { path } = await params
  const pathStr = path.join('/')
  const url = new URL(`${API_URL}/storage/${pathStr}`)
  const contentType = req.headers.get('content-type') || ''

  // Before the fetch, and counted during the read. multer refuses above 50MB on
  // the API side, but that refusal used to arrive AFTER this process had already
  // allocated the whole body.
  let payload: ArrayBuffer
  try {
    payload = await readBodyLimited(req, BODY_LIMIT_UPLOAD)
  } catch (err) {
    if (err instanceof BodyTooLargeError) return bodyTooLargeResponse(err)
    throw err
  }

  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.accessToken}`,
        'Content-Type': contentType,
      },
      body: payload,
      signal: AbortSignal.timeout(60000),
    })
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
    console.error('[storage-proxy-upload] Error:', err)
    return NextResponse.json({ error: 'API request failed' }, { status: 502, headers: NO_SHARED_CACHE })
  }
}

export const GET = proxyRequest
export const POST = proxyUpload
export const DELETE = proxyRequest
