'use client'

import { useState } from 'react'
import Toast, { useToast, failureMessage } from '@/components/Toast'
import { Bot, Key, Check } from 'lucide-react'

interface Props {
  agentId: string
  envVars: Record<string, string>
  agentStatus: string
  onUpdate: () => void
}

export default function AgentClaudeConfig({ agentId, envVars, agentStatus, onUpdate }: Props) {
  const [apiKey, setApiKey] = useState('')
  const { toast, showToast } = useToast()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const hasKey = !!envVars?.ANTHROPIC_API_KEY
  const isRunning = agentStatus === 'running'

  const handleSave = async () => {
    if (!apiKey.trim()) return
    setSaving(true)
    try {
      const updated = { ...(envVars || {}), ANTHROPIC_API_KEY: apiKey.trim() }
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env_vars: updated }),
      })
      if (res.ok) {
        setApiKey('')
        setSaved(true)
        setTimeout(() => setSaved(false), 3000)
        onUpdate()
      } else {
        // #217: the res.ok check was here and correct, and the failing branch
        // did nothing — so a rejected save looked exactly like a click that
        // had not registered.
        showToast('error', await failureMessage('Could not save the API key', res))
      }
    } catch {
      showToast('error', 'Could not save the API key: the request did not complete')
    }
    finally { setSaving(false) }
  }

  const handleRemove = async () => {
    if (!confirm('Remove Claude API key from this agent?')) return
    const updated = { ...(envVars || {}) }
    delete updated.ANTHROPIC_API_KEY
    // #217: this had NO res.ok check at all, four lines from handleSave which
    // does — the twin pattern CONTRIBUTING documents. On failure the key simply
    // reappeared after the refetch, with nothing saying why.
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env_vars: updated }),
      })
      if (!res.ok) {
        showToast('error', await failureMessage('Could not remove the API key', res))
      }
    } catch {
      showToast('error', 'Could not remove the API key: the request did not complete')
    }
    // The refetch runs either way: it is what puts the true state back on
    // screen, and it was never the missing piece — being told was.
    onUpdate()
  }

  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
      <Toast toast={toast} />
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-mountain-400" />
          <h2 className="text-lg font-semibold text-white">Claude Code</h2>
        </div>
        {saved && <span className="flex items-center gap-1 text-xs text-brand-400"><Check className="w-3 h-3" /> Saved</span>}
      </div>

      <p className="text-xs text-mountain-400 mb-3">
        Agents can use Claude Code CLI for AI-assisted coding. Provide your Anthropic API key to enable it.
        The key is injected as an environment variable when the agent starts.
      </p>

      {hasKey ? (
        <div className="flex items-center justify-between rounded border border-navy-600 bg-navy-900 px-3 py-2">
          <div className="flex items-center gap-2">
            <Key className="w-3.5 h-3.5 text-brand-400" />
            <span className="text-sm text-white">ANTHROPIC_API_KEY</span>
            <span className="text-xs text-brand-400 bg-brand-600/10 px-1.5 py-0.5 rounded">configured</span>
          </div>
          {!isRunning && (
            <button onClick={handleRemove} className="text-xs text-red-400 hover:text-red-300 cursor-pointer">Remove</button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sk-ant-api03-..."
              className="flex-1 rounded border border-navy-600 bg-navy-900 px-3 py-1.5 text-sm text-white font-mono placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
              disabled={isRunning}
            />
            <button onClick={handleSave} disabled={!apiKey.trim() || saving || isRunning}
              className="px-3 py-1.5 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-50 cursor-pointer">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
          {isRunning && <p className="text-xs text-amber-400">Stop the agent before changing credentials</p>}
          <p className="text-xs text-mountain-500">Get your API key from <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener" className="text-brand-400 hover:underline">console.anthropic.com</a></p>
        </div>
      )}
    </div>
  )
}
