import { NextResponse } from 'next/server'

/**
 * Runtime client configuration.
 *
 * Values the browser needs but that must not be inlined at build time — using
 * NEXT_PUBLIC_* would bake them into the bundle and tie one image to one
 * environment. This route is evaluated per request, so the same image works
 * locally and in production.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({
    // Base URL of the API's WebSocket server (agent terminal). The API serves
    // it on its own port, not through the UI, so it cannot be derived from
    // window.location. Falls back to the production host when unset.
    apiWsUrl: process.env.API_WS_URL || 'wss://api.hill90.com',
  })
}
