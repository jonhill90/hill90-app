import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { Session } from 'next-auth'
import ConnectionsClient from './ConnectionsClient'

// A platform-wide connection (created_by IS NULL server-side) alongside an
// owned one — this is the exact shape app#357's api fix now returns. The
// question this test answers is the rendering half of that fix: given
// is_platform, does the badge actually distinguish the two, or does a
// platform connection render indistinguishably from the viewer's own —
// which was #354's own class of defect (a consumer meeting a shape it
// hadn't met before), just on this page instead of the graph.
const mockConnections = [
  {
    id: 'conn-own', name: 'My OpenAI', provider: 'openai', api_base_url: null,
    is_valid: true, last_validated_at: '2026-08-01T00:00:00Z', last_validation_error: null,
    validation_latency_ms: 200, created_by: 'test-user', is_platform: false,
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  },
  {
    id: 'conn-platform', name: 'Platform OpenAI', provider: 'openai', api_base_url: null,
    is_valid: null, last_validated_at: null, last_validation_error: null,
    validation_latency_ms: null, created_by: null, is_platform: true,
    created_at: '2026-08-04T00:00:00Z', updated_at: '2026-08-04T00:00:00Z',
  },
]

function setupFetch() {
  return vi.fn(async (url: RequestInfo | URL) => {
    if (typeof url === 'string' && url.includes('/api/provider-connections/health')) {
      return { ok: true, json: async () => ({ total: 0, valid: 0, invalid: 0, untested: 0, by_provider: [] }) } as Response
    }
    if (typeof url === 'string' && url.includes('/api/provider-connections')) {
      return { ok: true, json: async () => mockConnections } as Response
    }
    if (typeof url === 'string' && url.includes('/api/user-models')) {
      return { ok: true, json: async () => [] } as Response
    }
    return { ok: false, json: async () => ({}) } as Response
  })
}

const mockSessionValue: Session = {
  user: { sub: 'test-user', roles: ['user'] } as any,
  expires: '2099-01-01T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = setupFetch() as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ConnectionsClient — platform-wide vs. owned connections', () => {
  it('labels a platform connection (is_platform: true) and not an owned one', async () => {
    render(<ConnectionsClient session={mockSessionValue} />)

    const platformCard = await screen.findByText('Platform OpenAI')
    const ownCard = await screen.findByText('My OpenAI')
    expect(platformCard).toBeInTheDocument()
    expect(ownCard).toBeInTheDocument()

    expect(screen.getByTestId('platform-badge-conn-platform')).toBeInTheDocument()
    expect(screen.queryByTestId('platform-badge-conn-own')).not.toBeInTheDocument()
  })

  it('renders a never-validated connection (is_valid: null) as Untested, not Invalid', async () => {
    render(<ConnectionsClient session={mockSessionValue} />)

    await screen.findByText('Platform OpenAI')

    // The platform connection's is_valid is null — the three-state case.
    // A misleading render (null shown as invalid/red) would be worse than a
    // crash, because it would be believed rather than investigated.
    expect(screen.getByTestId('health-dot-unknown')).toBeInTheDocument()
    expect(screen.queryByTestId('health-dot-invalid')).not.toBeInTheDocument()
    expect(screen.getByText('Untested')).toBeInTheDocument()
    expect(screen.queryByText('Invalid')).not.toBeInTheDocument()
  })
})
