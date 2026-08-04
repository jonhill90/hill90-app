/**
 * Five write paths that failed without saying so (#217).
 *
 * WHAT EACH ONE DID, established from the code before anything was written,
 * because the issue treats them as one defect and they are three:
 *
 *   SHOWED SUCCESS   TopBar.markAllRead flipped every badge to read and dropped
 *                    the PUT result on the floor. On failure the screen claimed
 *                    they were read until the 60s poll brought them back.
 *   SHOWED NOTHING   AgentClaudeConfig.handleRemove had no `res.ok` check at
 *                    all, four lines from handleSave which does; ChatLayout's
 *                    bulk delete counted no failures, so three deletions out of
 *                    seven looked like seven.
 *   REVERTED SILENT  TaskBoard's card snaps back, which is legible — but a
 *                    revert with no reason reads as a UI glitch, not a refusal.
 *
 * THE PATTERN CHOSEN: the toast that `harness/secrets/SecretsClient.tsx`
 * already had, extracted to `components/Toast.tsx` and reused — including by
 * SecretsClient, which now has no copy of its own. One implementation, not six.
 * The self-correcting refetch/poll/revert stays in every case: recovery was
 * never the missing piece, being told was.
 *
 * EVERY FIXTURE HERE FAILS. With a successful response the fixed and unfixed
 * versions are identical in all five, so a success-path test proves nothing —
 * the same control this repository has needed all day.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: 'Dev', roles: ['admin'] }, accessToken: 't' }, status: 'authenticated' }),
  signIn: vi.fn(), signOut: vi.fn(),
}))

const failing = (status = 500, body: unknown = { error: 'agent is running' }) =>
  vi.fn().mockResolvedValue({
    ok: false, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  // No auto-cleanup in this project's vitest setup: without this, the second
  // test finds two mounted copies and queries go ambiguous.
  cleanup()
  vi.unstubAllGlobals()
})

describe('AgentClaudeConfig — the path with no res.ok check at all', () => {
  it('POSITIVE CONTROL: a failed remove says so', async () => {
    vi.stubGlobal('fetch', failing())
    vi.stubGlobal('confirm', () => true)
    const { default: AgentClaudeConfig } = await import('@/app/agents/[id]/AgentClaudeConfig')

    render(<AgentClaudeConfig agentId="a1" envVars={{ ANTHROPIC_API_KEY: 'sk-x' }} onUpdate={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))

    const toast = await screen.findByTestId('toast-error')
    expect(toast.textContent).toMatch(/Could not remove the API key/)
    // The reason the api gave, not a generic failure.
    expect(toast.textContent).toMatch(/agent is running/)
  })

  it('TWIN: a successful remove says nothing — the toast must mean something', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }))
    vi.stubGlobal('confirm', () => true)
    const onUpdate = vi.fn()
    const { default: AgentClaudeConfig } = await import('@/app/agents/[id]/AgentClaudeConfig')

    render(<AgentClaudeConfig agentId="a1" envVars={{ ANTHROPIC_API_KEY: 'sk-x' }} onUpdate={onUpdate} />)
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))

    await waitFor(() => expect(onUpdate).toHaveBeenCalled())
    expect(screen.queryByTestId('toast-error')).toBeNull()
  })

  it('the refetch still runs on failure — recovery was never the missing piece', async () => {
    vi.stubGlobal('fetch', failing())
    vi.stubGlobal('confirm', () => true)
    const onUpdate = vi.fn()
    const { default: AgentClaudeConfig } = await import('@/app/agents/[id]/AgentClaudeConfig')

    render(<AgentClaudeConfig agentId="a1" envVars={{ ANTHROPIC_API_KEY: 'sk-x' }} onUpdate={onUpdate} />)
    fireEvent.click(screen.getByRole('button', { name: /remove/i }))

    await screen.findByTestId('toast-error')
    expect(onUpdate).toHaveBeenCalled()
  })
})

describe('TaskBoard — the path that reverts silently', () => {
  it('POSITIVE CONTROL: a refused transition says why, not just snaps back', async () => {
    // Driven through the real control — the quick-transition select — rather
    // than through the helper, because the question is what the COMPONENT does
    // when the PATCH is refused. The revert is the existing signal and stays;
    // what was missing is the reason, without which a snap-back reads as a UI
    // glitch rather than a refusal.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      String(url).includes('/transition')
        ? Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'task is locked' }) })
        : Promise.resolve({ ok: true, status: 200, json: async () => ([
            { id: 't1', title: 'Ship it', status: 'todo', priority: 2, tags: [],
              created_by: 'dev', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
          ]) })))
    const { default: TaskBoardClient } = await import('@/app/tasks/TaskBoardClient')

    render(<TaskBoardClient session={{ user: { roles: ['user'] } } as never} />)

    const select = await screen.findByTestId('quick-transition')
    fireEvent.change(select, { target: { value: 'in_progress' } })

    const toast = await screen.findByTestId('toast-error')
    expect(toast.textContent).toMatch(/Could not move the task/)
    expect(toast.textContent).toMatch(/task is locked/)
  })

  it('TWIN: a transition that succeeds says nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) =>
      String(url).includes('/transition')
        ? Promise.resolve({ ok: true, status: 200, json: async () => (
            { id: 't1', title: 'Ship it', status: 'in_progress', priority: 2, tags: [],
              created_by: 'dev', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' }) })
        : Promise.resolve({ ok: true, status: 200, json: async () => ([
            { id: 't1', title: 'Ship it', status: 'todo', priority: 2, tags: [],
              created_by: 'dev', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
          ]) })))
    const { default: TaskBoardClient } = await import('@/app/tasks/TaskBoardClient')

    render(<TaskBoardClient session={{ user: { roles: ['user'] } } as never} />)
    const select = await screen.findByTestId('quick-transition')
    fireEvent.change(select, { target: { value: 'in_progress' } })

    await waitFor(() => expect(screen.queryByTestId('toast-error')).toBeNull())
  })
})

describe('the message carries what the API said', () => {
  it('POSITIVE CONTROL: the error field is surfaced, not a bare status', async () => {
    const { failureMessage } = await import('@/components/Toast')
    const msg = await failureMessage('Could not save', {
      status: 400, json: async () => ({ error: 'env_vars must be an object' }),
    } as never)
    expect(msg).toBe('Could not save: env_vars must be an object')
  })

  it('TWIN: a body that will not parse falls back to the status, and leaks nothing', async () => {
    // #223: an upstream body can carry a stack trace. The status is the part
    // that is safe to put in front of a browser.
    const { failureMessage } = await import('@/components/Toast')
    const msg = await failureMessage('Could not save', {
      status: 502,
      json: async () => { throw new Error('not json') },
    } as never)
    expect(msg).toBe('Could not save: HTTP 502')
  })
})

describe('ChatLayout bulk delete — a partial result stated as partial', () => {
  // My first version of this test called the counting loop directly and I
  // bounded it as "the component cannot be tested without standing up the chat
  // page". That was wrong: it takes a `session` prop and fetches its own
  // threads, exactly like TaskBoardClient. The caveat described my effort, not
  // the component, so it is replaced rather than carried forward.
  const THREADS = [
    { id: 't1', title: 'One', last_message: 'Timed out', updated_at: '2026-08-01T00:00:00Z' },
    { id: 't2', title: 'Two', last_message: 'Timed out', updated_at: '2026-08-01T00:00:00Z' },
    { id: 't3', title: 'Three', last_message: 'Timed out', updated_at: '2026-08-01T00:00:00Z' },
  ]

  const listThenDeletes = (deleteResults: boolean[]) => {
    let d = 0
    return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        const ok = deleteResults[d++] ?? true
        return Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => ({ error: 'nope' }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => THREADS })
    })
  }

  it('POSITIVE CONTROL: two failures out of three are counted and named', async () => {
    vi.stubGlobal('fetch', listThenDeletes([true, false, false]))
    vi.stubGlobal('confirm', () => true)
    const { default: ChatLayout } = await import('@/app/chat/ChatLayout')

    render(<ChatLayout session={{ user: { roles: ['user'] } } as never} />)
    fireEvent.click(await screen.findByRole('button', { name: /clear/i }))

    const toast = await screen.findByTestId('toast-error')
    expect(toast.textContent).toMatch(/2 of 3/)
  })

  it('TWIN: when every delete succeeds, nothing is said', async () => {
    vi.stubGlobal('fetch', listThenDeletes([true, true, true]))
    vi.stubGlobal('confirm', () => true)
    const { default: ChatLayout } = await import('@/app/chat/ChatLayout')

    render(<ChatLayout session={{ user: { roles: ['user'] } } as never} />)
    fireEvent.click(await screen.findByRole('button', { name: /clear/i }))

    await waitFor(() => expect(screen.queryByTestId('toast-error')).toBeNull())
  })

  it('a network error counts as a failure too, not as a success', async () => {
    // The old loop's `catch { /* skip */ }` swallowed exactly this.
    let d = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        d++
        return d === 1 ? Promise.reject(new Error('ECONNRESET'))
                       : Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => THREADS })
    }))
    vi.stubGlobal('confirm', () => true)
    const { default: ChatLayout } = await import('@/app/chat/ChatLayout')

    render(<ChatLayout session={{ user: { roles: ['user'] } } as never} />)
    fireEvent.click(await screen.findByRole('button', { name: /clear/i }))

    const toast = await screen.findByTestId('toast-error')
    expect(toast.textContent).toMatch(/1 of 3/)
  })
})
