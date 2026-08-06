import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import ProfilesClient from '@/app/admin/profiles/ProfilesClient'

const MOCK_PROFILES = [
  {
    id: 'profile-1',
    name: 'Standard',
    description: 'Default profile',
    docker_image: 'hill90/agentbox:latest',
    default_cpus: '1.0',
    default_mem_limit: '1g',
    default_pids_limit: 200,
    is_platform: true,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'profile-2',
    name: 'Custom Heavy',
    description: '',
    docker_image: 'hill90/agentbox:heavy',
    default_cpus: '2.0',
    default_mem_limit: '4g',
    default_pids_limit: 400,
    is_platform: false,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
]

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockFetchDefaults(profiles = MOCK_PROFILES) {
  mockFetch.mockImplementation((url: string, opts?: any) => {
    if (url === '/api/container-profiles' && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(profiles) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('ProfilesClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDefaults()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders profile rows after fetch', async () => {
    render(<ProfilesClient />)
    await waitFor(() => {
      expect(screen.getByText('Standard')).toBeInTheDocument()
      expect(screen.getByText('Custom Heavy')).toBeInTheDocument()
    })
  })

  it('shows an error, not a silently-open form, when creating a profile fails', async () => {
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/container-profiles' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PROFILES) })
      }
      if (url === '/api/container-profiles' && opts?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'db unavailable' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<ProfilesClient />)
    await waitFor(() => {
      expect(screen.getByText('Standard')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('+ New Profile'))
    const formSection = screen.getByText('New Profile').closest('.rounded-lg')!
    const nameInput = formSection.querySelector('input')!
    fireEvent.change(nameInput, { target: { value: 'Broken Profile' } })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      expect(screen.getByText('db unavailable')).toBeInTheDocument()
    })
    // The form must still be open with the entered data — it must not look
    // like the profile was created.
    expect(screen.getByText('New Profile')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Broken Profile')).toBeInTheDocument()
  })

  it('shows an alert, not a silent no-op, when deleting a profile fails', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('alert', vi.fn())
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/container-profiles' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PROFILES) })
      }
      if (url === '/api/container-profiles/profile-2' && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'db unavailable' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<ProfilesClient />)
    await waitFor(() => {
      expect(screen.getByText('Custom Heavy')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('db unavailable')
    })
    expect(screen.getByText('Custom Heavy')).toBeInTheDocument()
  })

  // Twin of the test above, but the fetch itself REJECTS (a network
  // failure) rather than resolving with ok: false — the delete button's
  // onClick had no try/catch at all, so this used to be an unhandled
  // promise rejection with nothing shown to the user. The create/edit save
  // button got the identical fix, routing a rejected fetch to its own
  // existing setFormError path.
  it('shows an alert, not an unhandled rejection, when deleting a profile fails at the network level', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('alert', vi.fn())
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/container-profiles' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PROFILES) })
      }
      if (url === '/api/container-profiles/profile-2' && opts?.method === 'DELETE') {
        return Promise.reject(new Error('network error'))
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<ProfilesClient />)
    await waitFor(() => {
      expect(screen.getByText('Custom Heavy')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Failed to delete profile')
    })
    expect(screen.getByText('Custom Heavy')).toBeInTheDocument()
  })
})
