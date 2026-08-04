/**
 * The interface must not report success the server never gave.
 *
 * TWO DEFECTS, ONE SHAPE. Both told the user an action had happened and left
 * nothing behind to correct it:
 *
 *   SettingsClient flipped the toggle optimistically and, on failure, did
 *   nothing — so the switch kept showing the new value while the server kept the
 *   old one. Preferences are fetched ONCE on mount and never re-polled, so the
 *   lie survived the life of the page. For `email_notifications` that means
 *   believing you turned emails off while they keep arriving.
 *
 *   SessionPane's describe-element send had no `res.ok` check inside a
 *   `catch { /* ignore *\/ }`, then closed the popover and ERASED the typed
 *   description unconditionally. A 4xx looked exactly like a success, and the
 *   text was not even recoverable to retry.
 *
 * Both now follow ChatView.handleSend, which does this correctly a few files
 * away: apply optimistically, then restore the old value and say what went wrong
 * if the request fails.
 *
 * THE FIXTURE IS THE WHOLE TEST, AND IT IS THE SAME MISTAKE AS TWICE BEFORE
 * TODAY. With a SUCCESSFUL response the broken and fixed versions are byte-for-
 * byte identical — the toggle ends up flipped either way, the popover closes
 * either way. Only a fixture where the REQUEST FAILS can tell them apart.
 *
 * That is the same test-design error as a total computed from its own page (it
 * agrees with itself, so any fixture confirms it) and as a search count asserted
 * with fewer rows than the cap (page length equals match count, so both versions
 * emit the same string). Three unrelated defects, one mistake behind all of them:
 * choosing the fixture on which broken and fixed cannot differ.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a>,
}))
vi.mock('@/app/chat/XTerminal', () => ({ default: () => <div /> }))
vi.mock('@/app/agents/[id]/EventCard', () => ({ default: () => <div /> }))

class MockEventSource {
  close = vi.fn()
  onerror: ((e: unknown) => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  addEventListener() {}
  removeEventListener() {}
}
vi.stubGlobal('EventSource', MockEventSource)

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import SettingsClient from '@/app/settings/SettingsClient'

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: () => Promise.resolve(body),
})
const fails = (status = 500, body: unknown = { error: 'nope' }) => ({
  ok: false,
  status,
  headers: { get: () => null },
  json: () => Promise.resolve(body),
})

describe('SettingsClient — a toggle that did not save must not stay flipped', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => cleanup())

  /** Server starts with in-app notifications ON. */
  function wire(putResult: unknown) {
    mockFetch.mockImplementation((url: string, init?: any) => {
      if (String(url).includes('/api/profile/preferences')) {
        if (init?.method === 'PUT') return Promise.resolve(putResult as any)
        return Promise.resolve(ok({ in_app_notifications: true, email_notifications: false, theme: 'dark' }))
      }
      return Promise.resolve(ok({}))
    })
  }

  const toggle = async () => {
    const boxes = await screen.findAllByRole('checkbox')
    return boxes[0] as HTMLInputElement
  }

  it('POSITIVE CONTROL: reverts the toggle when the save FAILS', async () => {
    // The only fixture that can fail on the old code. With a 200 the toggle ends
    // up flipped in both versions and the test proves nothing.
    wire(fails(500))
    render(<SettingsClient />)

    const box = await toggle()
    await waitFor(() => expect(box.checked).toBe(true))

    fireEvent.click(box) // user turns it OFF

    // It must not remain off: the server never accepted it, and nothing else
    // will ever re-read the preference on this page.
    await waitFor(() => expect(box.checked).toBe(true))
  })

  it('says why, rather than snapping back with no explanation', async () => {
    wire(fails(403, { error: 'Not permitted' }))
    render(<SettingsClient />)

    const box = await toggle()
    await waitFor(() => expect(box.checked).toBe(true))
    fireEvent.click(box)

    // A toggle that silently reverts is still a silent failure — the user cannot
    // tell it from a mis-click.
    await waitFor(() => expect(screen.getByTestId('settings-error')).toBeInTheDocument())
    expect(screen.getByTestId('settings-error')).toHaveTextContent(/Not permitted/)
  })

  it('reverts on a network error too, not only on a bad status', async () => {
    mockFetch.mockImplementation((url: string, init?: any) => {
      if (String(url).includes('/api/profile/preferences')) {
        if (init?.method === 'PUT') return Promise.reject(new Error('offline'))
        return Promise.resolve(ok({ in_app_notifications: true, email_notifications: false, theme: 'dark' }))
      }
      return Promise.resolve(ok({}))
    })
    render(<SettingsClient />)

    const box = await toggle()
    await waitFor(() => expect(box.checked).toBe(true))
    fireEvent.click(box)

    await waitFor(() => expect(box.checked).toBe(true))
    expect(screen.getByTestId('settings-error')).toBeInTheDocument()
  })

  // Guard rail: the optimistic flip is the right behaviour and must survive.
  it('keeps the new value when the save SUCCEEDS', async () => {
    mockFetch.mockImplementation((url: string, init?: any) => {
      if (String(url).includes('/api/profile/preferences')) {
        if (init?.method === 'PUT') return Promise.resolve(ok({ in_app_notifications: false }))
        return Promise.resolve(ok({ in_app_notifications: true, email_notifications: false, theme: 'dark' }))
      }
      return Promise.resolve(ok({}))
    })
    render(<SettingsClient />)

    const box = await toggle()
    await waitFor(() => expect(box.checked).toBe(true))
    fireEvent.click(box)

    await waitFor(() => expect(box.checked).toBe(false))
    expect(screen.queryByTestId('settings-error')).toBeNull()
    // This assertion passes on the BROKEN code too — that is precisely the point,
    // and why it is a guard rail rather than the control.
  })
})

import SessionPane from '@/app/chat/SessionPane'

/**
 * The describe-element popover. Reaching it needs a screenshot, Take Control on,
 * Describe mode on, then a click on the image to select an element.
 */
describe('SessionPane describe — a send that failed must keep the text', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => cleanup())

  const ELEMENT = {
    tag: 'button', id: 'save', classes: ['btn'], text: 'Save',
    selector: 'button#save', box: { x: 10, y: 10, w: 50, h: 20 },
    outerHTML: '<button id="save">Save</button>',
  }

  function wire(sendResult: unknown) {
    mockFetch.mockImplementation((url: string, init?: any) => {
      const u = String(url)
      if (u.includes('/screenshot')) {
        return Promise.resolve(ok({ screenshot: 'AAAA', url: 'https://x.test' }))
      }
      // The route answers { success, element } — not the element directly.
      if (u.includes('/browser-element')) return Promise.resolve(ok({ success: true, element: ELEMENT }))
      if (u.includes('/messages') && init?.method === 'POST') {
        return Promise.resolve(sendResult as any)
      }
      return Promise.resolve(ok({}))
    })
  }

  /** Turn on Take Control + Describe, then click the screenshot to select. */
  async function openPopover() {
    const img = await screen.findByTestId('browser-screenshot')
    fireEvent.click(await screen.findByTestId('take-control-toggle'))
    fireEvent.click(await screen.findByText(/Describe/))
    fireEvent.click(img)
    return screen.findByPlaceholderText(/What should change here/)
  }

  it('POSITIVE CONTROL: keeps the popover and the typed text when the send FAILS', async () => {
    // With a 200 the popover closes in both versions; only a failure separates them.
    wire(fails(500, { error: 'Agent is busy' }))
    render(<SessionPane threadId="t1" initialTab="browser" />)

    const box = await openPopover()
    fireEvent.change(box, { target: { value: 'make this blue' } })
    fireEvent.click(screen.getByText('Send'))

    // The old code closed the popover and erased this, so the request was lost
    // AND unrecoverable.
    await waitFor(() => expect(screen.getByTestId('describe-error')).toBeInTheDocument())
    expect(screen.getByTestId('describe-error')).toHaveTextContent(/Agent is busy/)
    expect((await screen.findByPlaceholderText(/What should change here/)) as HTMLInputElement)
      .toHaveValue('make this blue')
  })

  it('keeps the text on a network error too', async () => {
    mockFetch.mockImplementation((url: string, init?: any) => {
      const u = String(url)
      if (u.includes('/screenshot')) return Promise.resolve(ok({ screenshot: 'AAAA', url: 'https://x.test' }))
      // The route answers { success, element } — not the element directly.
      if (u.includes('/browser-element')) return Promise.resolve(ok({ success: true, element: ELEMENT }))
      if (u.includes('/messages') && init?.method === 'POST') return Promise.reject(new Error('offline'))
      return Promise.resolve(ok({}))
    })
    render(<SessionPane threadId="t1" initialTab="browser" />)

    const box = await openPopover()
    fireEvent.change(box, { target: { value: 'keep me' } })
    fireEvent.click(screen.getByText('Send'))

    await waitFor(() => expect(screen.getByTestId('describe-error')).toBeInTheDocument())
    expect((await screen.findByPlaceholderText(/What should change here/)) as HTMLInputElement)
      .toHaveValue('keep me')
  })

  // Guard rail: a successful send must still close and clear.
  it('closes and clears when the send SUCCEEDS', async () => {
    wire(ok({ id: 'm1' }))
    render(<SessionPane threadId="t1" initialTab="browser" />)

    const box = await openPopover()
    fireEvent.change(box, { target: { value: 'make this blue' } })
    fireEvent.click(screen.getByText('Send'))

    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/What should change here/)).toBeNull(),
    )
    expect(screen.queryByTestId('describe-error')).toBeNull()
  })
})
