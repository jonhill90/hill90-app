'use client'

import { useState, useEffect, useCallback } from 'react'

interface AdminUser {
  id: string
  username: string
  email?: string
  firstName?: string
  lastName?: string
  enabled: boolean
  hill90UiRoles: string[]
}

export default function UsersClient() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchUsers = useCallback(async () => {
    try {
      setError(null)
      const res = await fetch('/api/admin/users')
      if (res.ok) {
        const body = await res.json()
        setUsers(body.users)
      } else {
        const body = await res.json().catch(() => ({}))
        // 503 specifically means the hill90-realm-admin credential is not
        // configured yet (app#500) — surfaced plainly rather than as a
        // generic error, since this is expected in production until that
        // client exists and its secret is in SOPS.
        setError(body.error || `Failed to load users (${res.status})`)
      }
    } catch {
      setError('Unable to reach the users API')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Users</h1>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 p-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {!loading && !error && (
        <div className="rounded-lg border border-navy-700 bg-navy-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-navy-900/50 text-left text-navy-400">
              <tr>
                <th className="px-4 py-3 font-medium">Username</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">hill90-ui roles</th>
                <th className="px-4 py-3 font-medium">Enabled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3 text-white">{u.username}</td>
                  <td className="px-4 py-3 text-navy-300">
                    {[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}
                  </td>
                  <td className="px-4 py-3 text-navy-300">{u.email || '—'}</td>
                  <td className="px-4 py-3 text-navy-300">
                    {u.hill90UiRoles.length > 0 ? u.hill90UiRoles.join(', ') : '—'}
                  </td>
                  <td className="px-4 py-3 text-navy-300">{u.enabled ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.length === 0 && (
            <div className="px-4 py-8 text-center text-navy-400">No users found.</div>
          )}
        </div>
      )}
    </div>
  )
}
