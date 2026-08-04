/**
 * The dashboard's two chat figures, which were wrong in two different ways
 * (issue #197).
 *
 * BOTH FIXTURES HERE ARE CHOSEN SO THE BROKEN AND FIXED VERSIONS DISAGREE. That
 * is the whole difficulty with these two defects:
 *
 *   messagesToday was structurally 0, because it summed `t.message_count` where
 *   `t.last_message_at >= todayUTC` and NEITHER field is in the response. Any
 *   fixture without messages passes on the broken code, and so does any assertion
 *   that the figure "is a number". So the count must be asserted NON-ZERO.
 *
 *   threads used `arr.length` — the length of a PAGE, bounded at 500 — while the
 *   api sends the real total in X-Total-Count. A fixture whose list is shorter
 *   than the page passes on the broken code, because page length and total agree.
 *   So the fixture must return FEWER ROWS THAN THE TOTAL, and the assertion must
 *   distinguish them.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a>,
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import DashboardClient from '@/app/dashboard/DashboardClient'

const SESSION = { user: { name: 'A', email: 'a@h.com' }, expires: '2099-01-01' }

/** A page of `n` threads — deliberately fewer than the total the api reports. */
const threadPage = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    title: `Thread ${i}`,
    updated_at: '2026-08-04T00:00:00.000Z',
    last_message: 'hi',
    last_author_type: 'human',
  }))

function jsonRes(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  }
}

/**
 * @param totalHeader what X-Total-Count carries, or null to omit it entirely
 */
function wireFetch(opts: { pageSize: number; totalHeader: string | null; messagesToday: number }) {
  mockFetch.mockImplementation((url: string) => {
    const u = String(url)
    if (u === '/api/chat') {
      return Promise.resolve(
        jsonRes(
          threadPage(opts.pageSize),
          opts.totalHeader === null ? {} : { 'x-total-count': opts.totalHeader },
        ),
      )
    }
    if (u === '/api/chat/stats') {
      return Promise.resolve(jsonRes({ messages_today: opts.messagesToday }))
    }
    if (u.startsWith('/api/services/health')) return Promise.resolve(jsonRes({ services: [] }))
    if (u.startsWith('/api/notifications')) return Promise.resolve(jsonRes({ notifications: [] }))
    if (u.startsWith('/api/shared-knowledge/stats')) return Promise.resolve(jsonRes({}))
    return Promise.resolve(jsonRes([]))
  })
}

describe('dashboard chat figures', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => cleanup())

  it('POSITIVE CONTROL: messagesToday is NON-ZERO when there are messages today', async () => {
    // The old code produced 0 here regardless. A fixture with no messages, or an
    // assertion that the figure merely renders, passes on the defect.
    wireFetch({ pageSize: 3, totalHeader: '3', messagesToday: 42 })

    render(<DashboardClient session={SESSION as any} />)

    await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument())
    expect(screen.queryByText('42')).not.toBeNull()
  })

  it('POSITIVE CONTROL: threads reports the TOTAL, not the page length', async () => {
    // 5 rows on the page, 1234 in the scope. The broken version renders 5 and the
    // fixed one renders 1234, so the fixture itself is the discriminator — a list
    // shorter than the page bound would have both versions agreeing.
    wireFetch({ pageSize: 5, totalHeader: '1234', messagesToday: 0 })

    render(<DashboardClient session={SESSION as any} />)

    await waitFor(() => expect(screen.getByText('1234')).toBeInTheDocument())
    expect(screen.queryByText('5')).toBeNull()
  })

  it('falls back to the page length when the header is absent, not to zero', async () => {
    // `headers.get` returns null and Number(null) is 0, which is finite and
    // non-negative — a naive parse would render "0 threads" here. Zero would be a
    // fresh instance of the very defect being fixed.
    wireFetch({ pageSize: 7, totalHeader: null, messagesToday: 0 })

    render(<DashboardClient session={SESSION as any} />)

    await waitFor(() => expect(screen.getByText('7')).toBeInTheDocument())
  })

  it('does not let a garbled header render as zero either', async () => {
    wireFetch({ pageSize: 4, totalHeader: 'not-a-number', messagesToday: 0 })

    render(<DashboardClient session={SESSION as any} />)

    await waitFor(() => expect(screen.getByText('4')).toBeInTheDocument())
  })
})
