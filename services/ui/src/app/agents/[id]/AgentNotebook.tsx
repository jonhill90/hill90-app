'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { fetchKnowledgePage, describePage } from '@/utils/knowledge-page'
import Markdown from 'react-markdown'

interface NotebookEntry {
  id: string
  agent_id: string
  path: string
  title: string
  entry_type: string
  tags: string[]
  status: string
  created_at: string
  updated_at: string
}

interface Props {
  agentId: string
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function AgentNotebook({ agentId }: Props) {
  const [entries, setEntries] = useState<NotebookEntry[]>([])
  // The server's count, not entries.length — null reads as unknown, never as
  // complete (#180).
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedEntry, setSelectedEntry] = useState<NotebookEntry | null>(null)
  const [selectedContent, setSelectedContent] = useState<string | null>(null)
  const [contentLoading, setContentLoading] = useState(false)

  const entriesRef = useRef<NotebookEntry[]>([])
  entriesRef.current = entries

  const fetchEntries = useCallback(async (append = false) => {
    const offset = append ? entriesRef.current.length : 0
    if (append) setLoadingMore(true)
    try {
      const page = await fetchKnowledgePage<NotebookEntry>(
        '/api/knowledge/entries',
        { agent_id: agentId, type: 'notebook' },
        { offset },
      )
      // Sort the accumulated set, not each page in isolation: two pages sorted
      // separately and concatenated are not one sorted list.
      const list = append ? [...entriesRef.current, ...page.entries] : page.entries
      list.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      setEntries(list)
      setTotal(page.total)
    } catch {
      // Non-fatal
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [agentId])

  useEffect(() => {
    fetchEntries()
  }, [fetchEntries])

  const loadEntryContent = (entry: NotebookEntry) => {
    setSelectedEntry(entry)
    setContentLoading(true)
    fetch(`/api/knowledge/entries/${agentId}/${entry.path}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => setSelectedContent(data?.content ?? null))
      .catch(() => setSelectedContent(null))
      .finally(() => setContentLoading(false))
  }

  // Detail view
  if (selectedEntry) {
    return (
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
        <div className="mb-3">
          <button
            onClick={() => { setSelectedEntry(null); setSelectedContent(null) }}
            className="text-sm text-brand-400 hover:text-brand-300 transition-colors cursor-pointer"
            data-testid="back-to-list"
          >
            Back to notebook
          </button>
        </div>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-white">{selectedEntry.title || selectedEntry.path}</h2>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-mountain-400">Updated {timeAgo(selectedEntry.updated_at)}</span>
            {selectedEntry.tags.length > 0 && selectedEntry.tags.map(tag => (
              <span key={tag} className="px-1.5 py-0.5 text-xs rounded-md border border-navy-600 text-mountain-400">
                {tag}
              </span>
            ))}
          </div>
        </div>
        {contentLoading ? (
          <div className="flex items-center justify-center py-8" data-testid="content-loading">
            <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
          </div>
        ) : selectedContent !== null ? (
          <div
            className="prose prose-invert prose-sm max-w-none text-mountain-300 [&_h1]:text-white [&_h2]:text-white [&_h3]:text-white [&_a]:text-brand-400 [&_code]:bg-navy-900 [&_code]:px-1 [&_code]:rounded [&_pre]:bg-navy-900 [&_pre]:rounded-md [&_pre]:p-4 [&_ul]:text-mountain-300 [&_ol]:text-mountain-300 [&_li]:text-mountain-300 [&_blockquote]:border-navy-600 [&_blockquote]:text-mountain-400 [&_strong]:text-white"
            data-testid="entry-content"
          >
            <Markdown>{selectedContent}</Markdown>
          </div>
        ) : (
          <p className="text-sm text-mountain-500">Failed to load entry content</p>
        )}
      </div>
    )
  }

  // List view
  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-white">Notebook</h2>
        {entries.length > 0 && (
          <p className="text-xs text-mountain-400 mt-1" data-testid="entry-count">
            {describePage(entries.length, total)}
          </p>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8" data-testid="loading">
          <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
        </div>
      ) : entries.length > 0 ? (
        <div className="space-y-2" data-testid="entry-list">
          {entries.map(entry => (
            <button
              key={entry.id}
              onClick={() => loadEntryContent(entry)}
              className="w-full text-left rounded-md border border-navy-700 bg-navy-900 p-3 hover:border-navy-500 transition-colors cursor-pointer"
              data-testid="entry-item"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-white">{entry.title || entry.path}</span>
                <span className="text-xs text-mountain-500 flex-shrink-0 ml-2">{timeAgo(entry.updated_at)}</span>
              </div>
              <p className="text-xs font-mono text-mountain-400 truncate">{entry.path}</p>
            </button>
          ))}
          {total !== null && entries.length < total && (
            <button
              onClick={() => fetchEntries(true)}
              disabled={loadingMore}
              className="w-full rounded-md border border-navy-700 bg-navy-900 p-2 text-sm text-mountain-300 hover:border-navy-500 disabled:opacity-50 transition-colors cursor-pointer"
              data-testid="load-more"
            >
              {loadingMore ? 'Loading…' : `Load more (${(total - entries.length).toLocaleString()} remaining)`}
            </button>
          )}
        </div>
      ) : (
        <p className="text-sm text-mountain-500" data-testid="empty-state">
          No notebook entries yet. This agent hasn&apos;t written any working notes.
        </p>
      )}
    </div>
  )
}
