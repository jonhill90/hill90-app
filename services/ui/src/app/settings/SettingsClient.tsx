'use client'

import { useState, useEffect, useCallback } from 'react'
import { Moon, Bell, KeyRound, Save, Check } from 'lucide-react'

interface Preferences {
  in_app_notifications: boolean
  email_notifications: boolean
  theme: string
}

export default function SettingsClient() {
  const [prefs, setPrefs] = useState<Preferences>({ in_app_notifications: true, email_notifications: false, theme: 'dark' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchPrefs = useCallback(async () => {
    try {
      const res = await fetch('/api/profile/preferences')
      if (res.ok) {
        const data = await res.json()
        setPrefs(p => ({ ...p, ...data }))
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchPrefs() }, [fetchPrefs])

  /**
   * Save, and PUT THE TOGGLE BACK if the server did not accept it.
   *
   * The caller flips the toggle optimistically before calling this, which is the
   * right thing to do — a settings switch that waits for a round-trip feels
   * broken. What was missing is the other half: on failure this did nothing at
   * all, so the toggle kept showing the new value while the server kept the old
   * one, and nothing ever corrected it. Preferences are fetched ONCE on mount and
   * never re-polled, so the lie survived for the life of the page. For
   * `email_notifications` that means believing you turned emails off while they
   * keep arriving — the contradiction surfaces somewhere the UI cannot be blamed.
   *
   * `previous` is captured by the caller and handed in, because only the caller
   * knows what the value was before it flipped it.
   *
   * This is ChatView.handleSend's pattern, not a new one: clear/flip optimistically,
   * restore the old value and show an error if the request fails. Matching a
   * convention the repository already agreed on beats introducing a third opinion.
   */
  const savePrefs = async (updates: Partial<Preferences>, previous: Partial<Preferences>) => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const res = await fetch('/api/profile/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (res.ok) {
        const data = await res.json()
        setPrefs(p => ({ ...p, ...data }))
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } else {
        const data = await res.json().catch(() => ({}))
        setPrefs(p => ({ ...p, ...previous }))
        setError(data.error || data.detail || `Could not save (${res.status})`)
      }
    } catch {
      setPrefs(p => ({ ...p, ...previous }))
      setError('Could not save — the change was not applied')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="flex justify-center py-12"><div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" /></div>
  }

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        {saved && <span className="flex items-center gap-1 text-sm text-brand-400"><Check className="w-4 h-4" /> Saved</span>}
      </div>

      {/* A reverted toggle with no explanation is still a silent failure: the user
          sees the switch snap back and cannot tell whether they mis-clicked. */}
      {error && (
        <div
          className="rounded-lg border border-red-700 bg-red-900/20 p-3 mb-4"
          role="alert"
          data-testid="settings-error"
        >
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <div className="space-y-6">
        {/* Theme */}
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
          <div className="flex items-center gap-2 mb-3">
            <Moon size={18} className="text-mountain-400" />
            <h2 className="text-lg font-semibold text-white">Theme</h2>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-navy-900 border border-brand-600 text-sm text-white">
              <Moon size={14} /> Dark
            </span>
            <span className="text-xs text-mountain-500">More themes coming soon</span>
          </div>
        </div>

        {/* Notifications */}
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
          <div className="flex items-center gap-2 mb-3">
            <Bell size={18} className="text-mountain-400" />
            <h2 className="text-lg font-semibold text-white">Notifications</h2>
          </div>
          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={prefs.in_app_notifications}
                onChange={(e) => {
                  const val = e.target.checked
                  const previous = { in_app_notifications: prefs.in_app_notifications }
                  setPrefs(p => ({ ...p, in_app_notifications: val }))
                  savePrefs({ in_app_notifications: val }, previous)
                }}
                className="h-4 w-4 rounded border-navy-600 bg-navy-900 text-brand-500 focus:ring-brand-500"
              />
              <div>
                <span className="text-sm text-white">In-app notifications</span>
                <p className="text-xs text-mountain-500">Show alerts in the notification panel</p>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={prefs.email_notifications}
                onChange={(e) => {
                  const val = e.target.checked
                  const previous = { email_notifications: prefs.email_notifications }
                  setPrefs(p => ({ ...p, email_notifications: val }))
                  savePrefs({ email_notifications: val }, previous)
                }}
                className="h-4 w-4 rounded border-navy-600 bg-navy-900 text-brand-500 focus:ring-brand-500"
              />
              <div>
                <span className="text-sm text-white">Email notifications</span>
                <p className="text-xs text-mountain-500">Receive email digests for important events</p>
              </div>
            </label>
          </div>
        </div>

        {/* API Keys — future */}
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-5 opacity-60">
          <div className="flex items-center gap-2 mb-3">
            <KeyRound size={18} className="text-mountain-400" />
            <h2 className="text-lg font-semibold text-white">API Keys</h2>
            <span className="text-xs px-2 py-0.5 rounded-full bg-navy-700 text-mountain-500">Coming soon</span>
          </div>
          <p className="text-sm text-mountain-400">Programmatic API access keys for external integrations.</p>
        </div>
      </div>
    </>
  )
}
