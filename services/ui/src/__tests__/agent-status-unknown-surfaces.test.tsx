/**
 * #251 — the five chat surfaces must not render an UNVERIFIED agent as stopped.
 *
 * #250 made the API honest: a `running` row that reconciliation could not check
 * against a real container is reported as `unknown`. Every surface here then
 * tested `status === 'running'` and sent everything else down the negative
 * branch, so the distinction was gathered, transmitted, and discarded at the
 * last hop — and the result was worse than the staleness it replaced. A stale
 * `running` was a soft claim that was usually right; a rendered *Stopped* is a
 * hard claim about an agent that may well be running.
 *
 * EVERY ASSERTION HERE USES AN `unknown` FIXTURE, and that is the whole point.
 * With a `running` or a `stopped` fixture the broken and the fixed component
 * are byte-identical — both send `running` down the positive branch and both
 * send `stopped` down the negative one. Such a test passes before the fix and
 * after it, which means it measures nothing. The twin assertions on `running`
 * and `stopped` are kept alongside, but only to show the third rendering did
 * not come at the cost of the first two.
 *
 * The negative form is deliberate too: `not.toHaveTextContent('Stopped')` is
 * the claim the issue is about. Asserting only that the word "Unverified"
 * appears would still pass a component that rendered BOTH.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

// Enumerated, not a Proxy: vitest has to introspect the module's exports and a
// Proxy that answers every key hangs the collector.
vi.mock('lucide-react', () => {
  const icon = (name: string) => {
    const Icon = (props: any) => <span data-testid={`icon-${name}`} {...props} />
    Icon.displayName = `Icon(${name})`
    return Icon
  }
  return {
    ArrowLeft: icon('arrow-left'), Send: icon('send'), Monitor: icon('monitor'),
    Terminal: icon('terminal'), Activity: icon('activity'), Globe: icon('globe'),
    Users: icon('users'), Paperclip: icon('paperclip'), Search: icon('search'),
    X: icon('x'), Trash2: icon('trash'), Plus: icon('plus'),
    UserMinus: icon('user-minus'), Crown: icon('crown'),
  }
})

vi.mock('@/app/chat/ChatMessage', () => ({
  default: ({ message }: any) => <div data-testid="chat-message">{message.content}</div>,
}))
vi.mock('@/app/chat/CancelButton', () => ({ default: () => <div data-testid="cancel-button" /> }))
vi.mock('@/app/chat/SessionPane', () => ({ default: () => <div data-testid="session-pane" /> }))
vi.mock('@/components/AgentAvatar', () => ({ default: () => <div data-testid="agent-avatar" /> }))

import AgentStatusBar from '@/app/chat/AgentStatusBar'
import ChatView from '@/app/chat/ChatView'
import ThreadList from '@/app/chat/ThreadList'
import MentionInput from '@/app/chat/MentionInput'
import ParticipantPanel from '@/app/chat/ParticipantPanel'
import NewThreadDialog from '@/app/chat/NewThreadDialog'
import type { ChatThread } from '@/app/chat/ChatLayout'

/** The status #250 introduced. Named once so a rename cannot leave this suite green. */
const UNKNOWN = 'unknown'

const mockSession = { user: { id: 'user-1', name: 'Test', roles: ['user'] }, expires: '2026-12-31' }

class MockEventSource {
  listeners: Record<string, ((e: any) => void)[]> = {}
  static instances: MockEventSource[] = []
  constructor(public url: string) { MockEventSource.instances.push(this) }
  addEventListener(type: string, cb: (e: any) => void) {
    (this.listeners[type] ||= []).push(cb)
  }
  removeEventListener() {}
  close() {}
}

function thread(status: string): ChatThread {
  return {
    id: 'thread-1',
    type: 'direct',
    title: 'Test Chat',
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    agent: { id: 'agent-1', agent_id: 'bot-1', name: 'TestBot', status },
  }
}

const mockFetch = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  MockEventSource.instances = []
  ;(globalThis as any).EventSource = MockEventSource
  vi.stubGlobal('fetch', mockFetch)
  mockFetch.mockImplementation(async () => ({ ok: true, json: async () => [] }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (globalThis as any).EventSource
})

// ── 1. ChatView — the surface that renders the literal words ──────────────

describe('#251 ChatView: an unverified agent is not labelled Stopped', () => {
  const props = (status: string) => ({
    threadId: 'thread-1',
    session: mockSession as any,
    thread: thread(status),
    onBack: vi.fn(),
    onThreadUpdated: vi.fn(),
  })

  it('does NOT render "Stopped" for an unknown status', () => {
    render(<ChatView {...props(UNKNOWN)} />)
    const label = screen.getByTestId('agent-status-label')
    expect(label).not.toHaveTextContent('Stopped')
    expect(label).toHaveTextContent('Unverified')
  })

  it('does not show the red stopped dot for an unknown status', () => {
    render(<ChatView {...props(UNKNOWN)} />)
    expect(screen.getByTestId('agent-status-dot').className).not.toContain('bg-red-400')
  })

  it('does not claim the agent is stopped in the banner, and says why instead', () => {
    render(<ChatView {...props(UNKNOWN)} />)
    expect(screen.queryByTestId('agent-stopped-warning')).not.toBeInTheDocument()
    expect(screen.getByTestId('agent-unverified-warning')).toHaveTextContent(
      'could not be verified against its container'
    )
  })

  it('leaves the composer usable — a reporting gap must not become an outage', () => {
    render(<ChatView {...props(UNKNOWN)} />)
    expect(screen.getByTestId('mention-input')).not.toBeDisabled()
    expect(screen.getByTestId('mention-input')).not.toHaveAttribute('placeholder', 'No agents running')
  })

  // Twins: the third rendering did not cost us the first two.
  it('still renders Running for a verified running agent', () => {
    render(<ChatView {...props('running')} />)
    expect(screen.getByTestId('agent-status-label')).toHaveTextContent('Running')
    expect(screen.queryByTestId('agent-unverified-warning')).not.toBeInTheDocument()
  })

  it('still renders Stopped, and still disables the composer, for a stopped agent', () => {
    render(<ChatView {...props('stopped')} />)
    expect(screen.getByTestId('agent-status-label')).toHaveTextContent('Stopped')
    expect(screen.getByTestId('agent-stopped-warning')).toBeInTheDocument()
    expect(screen.getByTestId('mention-input')).toBeDisabled()
  })
})

// ── 2. AgentStatusBar ──────────────────────────────────────────────────────

describe('#251 AgentStatusBar: an unverified agent is not labelled stopped', () => {
  it('does NOT render "stopped" for an unknown status', () => {
    render(<AgentStatusBar agents={[{ id: 'a1', agent_id: 'bot-1', name: 'Bot One', status: UNKNOWN }]} />)
    expect(screen.getByTestId('agent-status-item')).not.toHaveTextContent('stopped')
    expect(screen.getByTestId('agent-status-item')).toHaveTextContent('unverified')
  })

  it('still renders running and stopped for the two statuses it could always tell apart', () => {
    render(
      <AgentStatusBar
        agents={[
          { id: 'a1', agent_id: 'bot-1', name: 'Bot One', status: 'running' },
          { id: 'a2', agent_id: 'bot-2', name: 'Bot Two', status: 'stopped' },
        ]}
      />
    )
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('stopped')).toBeInTheDocument()
  })
})

// ── 3. ThreadList — where absence used to mean two different things ────────

describe('#251 ThreadList: an unverified agent is not silently dropped', () => {
  const listProps = (status: string) => ({
    threads: [{ ...thread(status), last_message: 'hi' }],
    loading: false,
    activeThreadId: undefined,
    onDelete: vi.fn(),
  })

  it('renders a distinct indicator for an unknown status rather than nothing', () => {
    render(<ThreadList {...listProps(UNKNOWN)} />)
    expect(screen.getByTestId('thread-unverified-dot')).toBeInTheDocument()
    // Not the running dot either — it is a third rendering, not a relabel.
    expect(screen.queryByTestId('thread-running-dot')).not.toBeInTheDocument()
  })

  it('still shows the running dot, and still shows nothing for stopped', () => {
    const { unmount } = render(<ThreadList {...listProps('running')} />)
    expect(screen.getByTestId('thread-running-dot')).toBeInTheDocument()
    unmount()
    render(<ThreadList {...listProps('stopped')} />)
    expect(screen.queryByTestId('thread-running-dot')).not.toBeInTheDocument()
    expect(screen.queryByTestId('thread-unverified-dot')).not.toBeInTheDocument()
  })
})

// ── 4. MentionInput — the @-picker dot ─────────────────────────────────────

describe('#251 MentionInput: an unverified agent is not shown as stopped', () => {
  function openPicker(status: string) {
    render(
      <MentionInput
        agents={[{ id: 'a1', agent_id: 'bot-1', name: 'Bot One', status }]}
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
        placeholder="type"
      />
    )
    fireEvent.change(screen.getByTestId('mention-input'), { target: { value: '@' } })
  }

  it('marks an unknown status as unverified, not as the stopped grey', () => {
    openPicker(UNKNOWN)
    const dot = screen.getByTestId('mention-status-dot')
    expect(dot.getAttribute('data-status-label')).toBe('unverified')
    expect(dot.className).not.toContain('bg-mountain-500')
  })

  it('still uses the stopped grey for a genuinely stopped agent', () => {
    openPicker('stopped')
    const dot = screen.getByTestId('mention-status-dot')
    expect(dot.getAttribute('data-status-label')).toBe('stopped')
    expect(dot.className).toContain('bg-mountain-500')
  })
})

// ── 5. ParticipantPanel — dot, and the filter decided on purpose ───────────

describe('#251 ParticipantPanel: unverified is marked, and kept addable', () => {
  const AVAILABLE = [
    { id: 'a9', agent_id: 'unverified-bot', name: 'UnverifiedBot', status: UNKNOWN },
    { id: 'a8', agent_id: 'stopped-bot', name: 'StoppedBot', status: 'stopped' },
    { id: 'a7', agent_id: 'running-bot', name: 'RunningBot', status: 'running' },
  ]

  const panelProps = (currentStatus: string) => ({
    threadId: 'thread-1',
    currentAgents: [{ id: 'a1', agent_id: 'bot-1', name: 'Bot One', status: currentStatus }],
    onUpdated: vi.fn(),
    onClose: vi.fn(),
  })

  beforeEach(() => {
    mockFetch.mockImplementation(async (url: string) =>
      typeof url === 'string' && url.includes('/api/agents')
        ? { ok: true, json: async () => AVAILABLE }
        : { ok: true, json: async () => ({ participants: [] }) }
    )
  })

  it('does not show a current unverified participant with the stopped grey dot', async () => {
    render(<ParticipantPanel {...panelProps(UNKNOWN)} />)
    const dot = await screen.findByTestId('participant-status-dot')
    expect(dot.getAttribute('data-status-label')).toBe('unverified')
    expect(dot.className).not.toContain('bg-mountain-500')
  })

  it('keeps an unverifiable agent in the add list — absence would be indistinguishable from having none', async () => {
    render(<ParticipantPanel {...panelProps('running')} />)
    await waitFor(() => expect(screen.getAllByTestId('add-agent-button').length).toBeGreaterThan(0))
    expect(screen.getByText('UnverifiedBot')).toBeInTheDocument()
  })

  it('still excludes a genuinely stopped agent from the add list', async () => {
    render(<ParticipantPanel {...panelProps('running')} />)
    await waitFor(() => expect(screen.getAllByTestId('add-agent-button').length).toBeGreaterThan(0))
    expect(screen.queryByText('StoppedBot')).not.toBeInTheDocument()
  })
})

// ── 6. NewThreadDialog — the same filter decision, stated ──────────────────

describe('#251 NewThreadDialog: an unverifiable agent stays in the picker', () => {
  beforeEach(() => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => [
        { id: 'a1', agent_id: 'running-bot', name: 'RunningBot', status: 'running' },
        { id: 'a2', agent_id: 'unverified-bot', name: 'UnverifiedBot', status: UNKNOWN },
        { id: 'a3', agent_id: 'stopped-bot', name: 'StoppedBot', status: 'stopped' },
      ],
    }))
  })

  it('offers the unverifiable agent, marked, rather than hiding it', async () => {
    render(<NewThreadDialog onClose={vi.fn()} onCreated={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('agent-picker')).toBeInTheDocument())
    expect(screen.getByText('UnverifiedBot')).toBeInTheDocument()
    expect(screen.getByText('unverified')).toBeInTheDocument()
  })

  it('still hides a genuinely stopped agent', async () => {
    render(<NewThreadDialog onClose={vi.fn()} onCreated={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('agent-picker')).toBeInTheDocument())
    expect(screen.queryByText('StoppedBot')).not.toBeInTheDocument()
    expect(screen.getByText('RunningBot')).toBeInTheDocument()
  })
})
