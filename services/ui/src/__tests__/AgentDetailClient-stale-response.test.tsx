/**
 * A response for the agent you LEFT must not land on the agent you are looking at.
 *
 * `app/agents/[id]/page.tsx` renders `<AgentDetailClient agentId={id} …/>` with no
 * `key`, so navigating /agents/A → /agents/B changes the prop WITHOUT remounting.
 * State survives, and so do in-flight requests: A's response can resolve after
 * B's and overwrite it.
 *
 * WHY THIS IS NOT A COSMETIC RACE. `fetchAgent` sets the schedule form fields:
 *
 *     setAgent(data); setScheduleCron(data.schedule_cron || '')
 *
 * and `handleScheduleSave` PUTs to `/api/agents/${agentId}/schedule` — the agent
 * you are LOOKING AT — carrying `scheduleCron`, the value in state. So a late
 * response from A leaves B's page displaying A's cron, and saving writes A's
 * schedule onto B. Nothing on screen says otherwise: the URL, the heading and the
 * save target are all B.
 *
 * The test drives exactly that order: start A, switch to B, let B resolve, then
 * resolve A late.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))
vi.mock('@/app/agents/[id]/EventTimeline', () => ({ default: () => <div /> }))
vi.mock('@/app/agents/[id]/ActivityTimeline', () => ({ default: () => <div /> }))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import AgentDetailClient from '@/app/agents/[id]/AgentDetailClient'

const ADMIN = { user: { name: 'A', email: 'a@h.com', roles: ['admin'] }, expires: '2099-01-01' }

function agent(id: string, cron: string) {
  return {
    id, agent_id: id, name: `Agent ${id}`, description: '', status: 'stopped',
    tools_config: {}, cpus: '1.0', mem_limit: '1g', pids_limit: 200,
    soul_md: '', rules_md: '', created_at: '2026-01-01T00:00:00Z',
    model_policy_id: null, skills: [], schedule_cron: cron, schedule_enabled: true,
  }
}

/** A fetch whose /api/agents/<id> responses resolve only when told to. */
function deferredAgentFetch() {
  const gates: Record<string, (v: unknown) => void> = {}
  mockFetch.mockImplementation((url: string) => {
    const m = /^\/api\/agents\/([^/?]+)$/.exec(String(url))
    if (m) {
      return new Promise((resolve) => {
        gates[m[1]] = () =>
          resolve({ ok: true, status: 200, json: () => Promise.resolve(agent(m[1], `${m[1]}-cron`)) })
      })
    }
    // Everything else this page fetches: answer immediately and boringly.
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) })
  })
  return gates
}

describe('a late response from the previous agent must not overwrite the current one', () => {
  beforeEach(() => { mockFetch.mockReset() })
  afterEach(() => cleanup())

  it('keeps B\'s schedule when A resolves after the switch', async () => {
    const gates = deferredAgentFetch()

    const { rerender } = render(<AgentDetailClient agentId="agent-a" session={ADMIN as any} />)
    await waitFor(() => expect(gates['agent-a']).toBeTypeOf('function'))

    // Navigate to B. Same component instance — no key on it in page.tsx.
    rerender(<AgentDetailClient agentId="agent-b" session={ADMIN as any} />)
    await waitFor(() => expect(gates['agent-b']).toBeTypeOf('function'))

    gates['agent-b']()                              // B lands first
    await waitFor(() => expect(screen.getByText('Agent agent-b')).toBeInTheDocument())

    // The schedule form lives on the Configuration tab.
    fireEvent.click(screen.getByText('Configuration'))
    await waitFor(() => expect(screen.getByDisplayValue('agent-b-cron')).toBeInTheDocument())

    gates['agent-a']()                              // A lands LATE
    await new Promise((r) => setTimeout(r, 50))

    // The page is B's. The form must still be B's, or saving writes A's
    // schedule onto B.
    expect(screen.queryByDisplayValue('agent-a-cron')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('agent-b-cron')).toBeInTheDocument()
    // And the page identity never wavered.
    expect(screen.getByText('Agent agent-b')).toBeInTheDocument()
  })
})
