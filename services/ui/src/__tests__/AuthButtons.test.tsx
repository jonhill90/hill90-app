import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next-auth/react
const mockSignIn = vi.fn()
let mockSession: any = { data: null, status: 'unauthenticated' }

vi.mock('next-auth/react', () => ({
  useSession: () => mockSession,
  signIn: (...args: any[]) => mockSignIn(...args),
}))

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

import AuthButtons from '@/components/AuthButtons'

describe('AuthButtons', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders sign-in avatar button when unauthenticated', () => {
    mockSession = { data: null, status: 'unauthenticated' }

    render(<AuthButtons />)

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('renders pulsing placeholder during loading', () => {
    mockSession = { data: null, status: 'loading' }

    render(<AuthButtons />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByLabelText('Loading user information')).toBeInTheDocument()
  })

  it('renders avatar button with initials when authenticated', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    expect(screen.getByText('AH')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'User menu' })).toBeInTheDocument()
  })

  it('avatar button has aria-haspopup="menu" and aria-expanded toggles', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    const button = screen.getByRole('button', { name: 'User menu' })
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
    expect(button).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })

  it('clicking avatar opens dropdown with Profile, Settings, Sign out', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))

    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Profile')
    expect(items[1]).toHaveTextContent('Settings')
    expect(items[2]).toHaveTextContent('Sign out')
  })

  it('clicking avatar again closes dropdown', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    const button = screen.getByRole('button', { name: 'User menu' })
    fireEvent.click(button)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.click(button)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('Escape key closes dropdown', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('Sign out item links to /api/auth/federated-logout', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))

    const signOutItem = screen.getByRole('menuitem', { name: 'Sign out' })
    expect(signOutItem).toHaveAttribute('href', '/api/auth/federated-logout')
  })

  it('menu items have role="menuitem"', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))

    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(3)
  })

  it('Profile links to /profile', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))

    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveAttribute('href', '/profile')
  })

  it('Settings links to /settings', () => {
    mockSession = {
      data: { user: { name: 'Admin Hill90' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings')
  })

  it('renders single initial for single-word names', () => {
    mockSession = {
      data: { user: { name: 'Madonna' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    expect(screen.getByText('M')).toBeInTheDocument()
  })

  it('renders initials from the first two words for multi-word names', () => {
    mockSession = {
      data: { user: { name: 'John Paul Jones' } },
      status: 'authenticated',
    }

    render(<AuthButtons />)

    expect(screen.getByText('JP')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// The avatar request that fires on every authenticated page load.
//
// GET /api/profile/avatar answers 204 for a user who has never uploaded one.
// 204 is a 2xx, so `res.ok` is true — checking res.ok alone builds an object URL
// from an empty Blob and renders a broken image. These tests pin the distinction.
//
// They settle the pending fetch BEFORE asserting. An earlier version used
// waitFor(initials are shown), which passes on the very first render — before
// the fetch resolves — so it held for both the correct and the broken component.
// A negative assertion has to be made after the thing it denies could have
// happened, or it proves nothing.
// ---------------------------------------------------------------------------

describe('AuthButtons avatar fetch', () => {
  let createdUrls: string[]
  let blobRead: number

  // Flush the fetch promise, the blob() promise and the resulting setState.
  async function settle() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }

  function stubFetch(status: number, ok = true) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      status,
      blob: async () => {
        blobRead += 1
        return new Blob(status === 204 ? [] : ['webp-bytes'])
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  beforeEach(() => {
    createdUrls = []
    blobRead = 0
    mockSession = { data: { user: { name: 'Admin Hill90' } }, status: 'authenticated' }
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => {
        const u = `blob:fake-${createdUrls.length}`
        createdUrls.push(u)
        return u
      }),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    cleanup()
  })

  it('does not read the body or create an object URL when the answer is 204', async () => {
    const fetchMock = stubFetch(204)

    render(<AuthButtons />)
    await settle()

    expect(fetchMock).toHaveBeenCalledWith('/api/profile/avatar')
    expect(blobRead).toBe(0)
    expect(createdUrls).toEqual([])
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('AH')).toBeInTheDocument()
  })

  it('renders the image when the answer is 200 with a body', async () => {
    stubFetch(200)

    render(<AuthButtons />)
    await settle()

    expect(blobRead).toBe(1)
    expect(createdUrls).toHaveLength(1)
    const img = document.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe(createdUrls[0])
    expect(screen.queryByText('AH')).toBeNull()
  })

  it('falls back to initials when the request fails outright', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    render(<AuthButtons />)
    await settle()

    expect(createdUrls).toEqual([])
    expect(screen.getByText('AH')).toBeInTheDocument()
  })
})
