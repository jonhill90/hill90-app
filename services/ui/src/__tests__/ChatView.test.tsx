import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockRouter = { push: vi.fn(), back: vi.fn(), refresh: vi.fn() }

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('lucide-react', () => ({
  ArrowLeft: (props: any) => <span data-testid="icon-arrow-left" {...props} />,
  Send: (props: any) => <span data-testid="icon-send" {...props} />,
  Terminal: (props: any) => <span data-testid="icon-terminal" {...props} />,
  Users: (props: any) => <span data-testid="icon-users" {...props} />,
  Paperclip: (props: any) => <span data-testid="icon-paperclip" {...props} />,
  Search: (props: any) => <span data-testid="icon-search" {...props} />,
  X: (props: any) => <span data-testid="icon-x" {...props} />,
  Globe: (props: any) => <span data-testid="icon-globe" {...props} />,
  Monitor: (props: any) => <span data-testid="icon-monitor" {...props} />,
  Activity: (props: any) => <span data-testid="icon-activity" {...props} />,
  MousePointerClick: (props: any) => <span data-testid="icon-mouse" {...props} />,
}))

vi.mock('@/app/chat/ChatMessage', () => ({
  default: ({ message }: any) => <div data-testid="chat-message">{message.content}</div>,
}))

vi.mock('@/app/chat/AgentStatusBar', () => ({
  default: () => <div data-testid="agent-status-bar" />,
}))

vi.mock('@/app/chat/CancelButton', () => ({
  default: () => <div data-testid="cancel-button" />,
}))

vi.mock('@/app/chat/SessionPane', () => ({
  default: () => <div data-testid="session-pane" />,
}))

import ChatView from '@/app/chat/ChatView'
import type { ChatThread } from '@/app/chat/ChatLayout'

const mockSession = {
  user: { id: 'user-1', name: 'Test', roles: ['user'] },
  expires: '2026-12-31',
}

const mockThread: ChatThread = {
  id: 'thread-1',
  type: 'direct',
  title: 'Test Chat',
  created_by: 'user-1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  agent: { id: 'agent-1', agent_id: 'bot-1', name: 'TestBot', status: 'running' },
}

// Mock EventSource
class MockEventSource {
  url: string
  onmessage: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
  listeners: Record<string, ((e: any) => void)[]> = {}
  static instances: MockEventSource[] = []
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  addEventListener(type: string, cb: (e: any) => void) {
    if (!this.listeners[type]) this.listeners[type] = []
    this.listeners[type].push(cb)
  }
  removeEventListener() {}
  close() {}
}

describe('ChatView', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    MockEventSource.instances = []
    ;(globalThis as any).EventSource = MockEventSource
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
    delete (globalThis as any).EventSource
  })

  const defaultProps = {
    threadId: 'thread-1',
    session: mockSession as any,
    thread: mockThread,
    onBack: vi.fn(),
    onThreadUpdated: vi.fn(),
  }

  // ── #203: a truncated thread must say so ──────────────────────────────
  //
  // The stream used to replay every message ever sent. It now replays a tail,
  // and the notice below is the only thing standing between that and a chat
  // that silently drops its own history. Every fixture makes the two numbers
  // DISAGREE — 2 shown, 40,000 in the thread — because a fixture where they
  // match is passed by an implementation that renders messages.length.

  function emit(es: MockEventSource, type: string, payload: unknown) {
    for (const cb of es.listeners[type] || []) cb({ data: JSON.stringify(payload) })
  }

  function msg(seq: number) {
    return {
      id: `m${seq}`, seq, author_id: 'user-1', author_type: 'human', role: 'user',
      content: `hello ${seq}`, status: 'complete', created_at: '2026-01-01T00:00:00Z',
    }
  }

  it('says it is showing the last N of M when the stream truncated', async () => {
    render(<ChatView {...defaultProps} />)
    const es = MockEventSource.instances[0]

    emit(es, 'backfill', { sent: 2, total: 40000, oldest_seq_sent: 39999, has_older: true })
    emit(es, 'message', msg(39999))
    emit(es, 'message', msg(40000))

    await waitFor(() => {
      expect(screen.getByTestId('older-messages-notice')).toBeInTheDocument()
    })
    const notice = screen.getByTestId('older-messages-notice')
    expect(notice).toHaveTextContent('Showing the last 2 of 40,000 messages')
    // The count rendered is the page; the total is the thread. They differ.
    expect(screen.getAllByTestId('chat-message')).toHaveLength(2)
  })

  it('shows NO notice when the replay was the whole thread', async () => {
    render(<ChatView {...defaultProps} />)
    const es = MockEventSource.instances[0]

    emit(es, 'backfill', { sent: 2, total: 2, oldest_seq_sent: 1, has_older: false })
    emit(es, 'message', msg(1))

    await waitFor(() => expect(screen.getAllByTestId('chat-message')).toHaveLength(1))
    expect(screen.queryByTestId('older-messages-notice')).not.toBeInTheDocument()
  })

  it('shows no notice at all when the server sent no backfill frame', async () => {
    // An older API deployed in front of this UI sends no such event. Absence
    // must read as "nothing to say", never as a truncation warning on a
    // complete thread.
    render(<ChatView {...defaultProps} />)
    const es = MockEventSource.instances[0]
    emit(es, 'message', msg(1))

    await waitFor(() => expect(screen.getAllByTestId('chat-message')).toHaveLength(1))
    expect(screen.queryByTestId('older-messages-notice')).not.toBeInTheDocument()
  })

  it('loads older messages by cursor and prepends them', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [msg(39997), msg(39998)], has_older: true }),
    })
    globalThis.fetch = fetchMock as any

    render(<ChatView {...defaultProps} />)
    const es = MockEventSource.instances[0]
    emit(es, 'backfill', { sent: 1, total: 40000, oldest_seq_sent: 39999, has_older: true })
    emit(es, 'message', msg(39999))

    await waitFor(() => expect(screen.getByTestId('load-older')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('load-older'))

    await waitFor(() => expect(screen.getAllByTestId('chat-message')).toHaveLength(3))

    // before_seq, not offset: seq is reassigned by the stale reconcile, so an
    // offset over this table skips and repeats.
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('before_seq=39999')
    expect(url).not.toContain('offset=')

    // Prepended, so the conversation still reads oldest-first.
    const rendered = screen.getAllByTestId('chat-message').map(n => n.textContent)
    expect(rendered[0]).toBe('hello 39997')
    expect(rendered[2]).toBe('hello 39999')
  })

  it('stops offering older messages once the server says there are none', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [], has_older: false }),
    }) as any

    render(<ChatView {...defaultProps} />)
    const es = MockEventSource.instances[0]
    emit(es, 'backfill', { sent: 1, total: 2, oldest_seq_sent: 2, has_older: true })

    await waitFor(() => expect(screen.getByTestId('load-older')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('load-older'))

    await waitFor(() => {
      expect(screen.queryByTestId('older-messages-notice')).not.toBeInTheDocument()
    })
  })

  it('renders message input', () => {
    render(<ChatView {...defaultProps} />)
    expect(screen.getByPlaceholderText('Type a message...')).toBeInTheDocument()
    expect(screen.getByTestId('icon-send')).toBeInTheDocument()
  })

  it('renders back button', () => {
    render(<ChatView {...defaultProps} />)
    expect(screen.getByTestId('icon-arrow-left')).toBeInTheDocument()
  })

  it('sends message on form submit', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    })
    globalThis.fetch = mockFetch

    render(<ChatView {...defaultProps} />)
    const input = screen.getByPlaceholderText('Type a message...')
    fireEvent.change(input, { target: { value: 'Hello agent' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/chat/thread-1/messages',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ message: 'Hello agent' }),
        })
      )
    })
  })

  it('shows error when send fails', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Server error' }),
    })
    globalThis.fetch = mockFetch

    render(<ChatView {...defaultProps} />)
    const input = screen.getByPlaceholderText('Type a message...')
    fireEvent.change(input, { target: { value: 'Hello' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    await waitFor(() => {
      expect(screen.getByText('Server error')).toBeInTheDocument()
    })
  })

  it('connects to SSE stream on mount', () => {
    render(<ChatView {...defaultProps} />)
    expect(MockEventSource.instances.length).toBe(1)
    expect(MockEventSource.instances[0].url).toBe('/api/chat/thread-1/stream')
  })

  it('renders attach file button', () => {
    render(<ChatView {...defaultProps} />)
    expect(screen.getByTestId('attach-file-button')).toBeInTheDocument()
    expect(screen.getByTestId('icon-paperclip')).toBeInTheDocument()
  })

  it('attach button triggers file input', () => {
    render(<ChatView {...defaultProps} />)
    // Attach button exists and is clickable (opens hidden file input)
    const btn = screen.getByTestId('attach-file-button')
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    // No toast initially — only shows during upload
  })
})
