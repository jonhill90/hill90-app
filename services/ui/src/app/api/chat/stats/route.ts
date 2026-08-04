import { NextRequest } from 'next/server'
import { proxyToApi } from '@/utils/api-proxy'

/**
 * A static segment, so it wins over `[...path]` for /api/chat/stats.
 *
 * It needs its own file because the catch-all hardcodes `/chat/threads/${path}`
 * — routing /api/chat/stats through it would reach /chat/threads/stats, which is
 * not where this lives. Bending the api's URL to fit the proxy's prefix was the
 * alternative, and it would have put a caller's convenience into the contract.
 */
async function proxyRequest(req: NextRequest) {
  return proxyToApi(req, '/chat/stats', { label: 'chat-proxy' })
}

export const GET = proxyRequest
