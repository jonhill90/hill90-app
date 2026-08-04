'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { fetchKnowledgePage, describePage } from '@/utils/knowledge-page'

const ENTRY_TYPES = ['note', 'plan', 'decision', 'journal', 'research'] as const
type EntryType = typeof ENTRY_TYPES[number]
type TypeFilter = 'all' | EntryType

function typeBadgeColor(type: string): string {
  switch (type) {
    case 'plan': return 'bg-blue-900/40 text-blue-400 border-blue-700'
    case 'decision': return 'bg-purple-900/40 text-purple-400 border-purple-700'
    case 'journal': return 'bg-amber-900/40 text-amber-400 border-amber-700'
    case 'research': return 'bg-cyan-900/40 text-cyan-400 border-cyan-700'
    case 'note':
    default: return 'bg-navy-700/50 text-mountain-300 border-navy-600'
  }
}

function renderHeadline(text: string): React.ReactNode {
  const parts = text.split('**')
  return parts.map((part, i) =>
    i % 2 === 1
      ? React.createElement('strong', { key: i, className: 'text-white' }, part)
      : part
  )
}

interface Entry {
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

interface SearchResult extends Entry {
  score: number
  headline: string
}

interface Props {
  agentId: string
}

export default function AgentMemory({ agentId }: Props) {
  const [entries, setEntries] = useState<Entry[]>([])
  // `total` is what the server says exists, NOT entries.length. Null means no
  // hop in the chain reported one, and that must read as unknown rather than
  // as complete.
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  /**
   * How many entries MATCHED, which is not how many came back — the api caps the
   * page at 20. Rendering `searchResults.length` said "20 results" over a corpus
   * of 500 matches, and looked right because twenty rows were showing (#197 sweep).
   */
  const [searchTotal, setSearchTotal] = useState<number | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null)
  const [selectedContent, setSelectedContent] = useState<string | null>(null)
  const [contentLoading, setContentLoading] = useState(false)

  // Read inside the callback rather than closing over `entries`, so appending
  // does not re-create the callback and re-trigger the initial-load effect.
  const entriesRef = useRef<Entry[]>([])
  entriesRef.current = entries

  const fetchEntries = useCallback(async (append = false) => {
    const offset = append ? entriesRef.current.length : 0
    if (!append) setLoading(true)
    else setLoadingMore(true)
    try {
      // The type filter goes UPSTREAM, not over the loaded page. Filtering a
      // page client-side was fine while the endpoint returned every row; now
      // that it returns 100, it would show "3 notes" out of a possible
      // thousand and look complete (#180).
      const page = await fetchKnowledgePage<Entry>('/api/knowledge/entries', {
        agent_id: agentId,
        ...(typeFilter === 'all' ? {} : { type: typeFilter }),
      }, { offset })

      setEntries(prev => (append ? [...prev, ...page.entries] : page.entries))
      setTotal(page.total)
    } catch {
      // Non-fatal
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [agentId, typeFilter])

  useEffect(() => {
    fetchEntries()
  }, [fetchEntries])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (!search.trim()) return
    setSearchLoading(true)
    fetch(`/api/knowledge/search?q=${encodeURIComponent(search.trim())}&agent_id=${agentId}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.results) {
          setSearchResults(data.results)
          const t = Number(data.total_matches)
          setSearchTotal(Number.isFinite(t) ? t : data.results.length)
        } else {
          setSearchResults([])
          setSearchTotal(0)
        }
      })
      .catch(() => { setSearchResults([]); setSearchTotal(null) })
      .finally(() => setSearchLoading(false))
  }

  const loadEntryContent = (entry: Entry) => {
    setSelectedEntry(entry)
    setContentLoading(true)
    fetch(`/api/knowledge/entries/${agentId}/${entry.path}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => setSelectedContent(data?.content ?? null))
      .catch(() => setSelectedContent(null))
      .finally(() => setContentLoading(false))
  }

  // The type filter is applied upstream now, so the page IS the filtered set.
  const filtered = entries

  // Per-type counts can only be computed from what is loaded, so they are
  // shown ONLY when the page is the whole set. A breakdown of a truncated
  // page is a set of small numbers that look like the answer.
  const isComplete = total !== null && total <= entries.length
  const typeCounts = isComplete
    ? entries.reduce<Record<string, number>>((acc, e) => {
        acc[e.entry_type] = (acc[e.entry_type] || 0) + 1
        return acc
      }, {})
    : {}

  const hasMore = total !== null && entries.length < total

  // Entry detail view
  if (selectedEntry) {
    return (
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
        <div className="mb-3">
          <button
            onClick={() => { setSelectedEntry(null); setSelectedContent(null) }}
            className="text-sm text-brand-400 hover:text-brand-300 transition-colors cursor-pointer"
            data-testid="back-to-list"
          >
            Back to list
          </button>
        </div>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-white">{selectedEntry.title || selectedEntry.path}</h2>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs font-mono text-mountain-400">{selectedEntry.path}</span>
            <span className={`px-1.5 py-0.5 text-xs rounded-md border ${typeBadgeColor(selectedEntry.entry_type)}`}>
              {selectedEntry.entry_type}
            </span>
          </div>
        </div>
        {contentLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
          </div>
        ) : selectedContent !== null ? (
          <pre className="text-sm text-mountain-300 whitespace-pre-wrap bg-navy-900 rounded-md p-4 max-h-96 overflow-auto" data-testid="entry-content">
            {selectedContent}
          </pre>
        ) : (
          <p className="text-sm text-mountain-500">Failed to load entry content</p>
        )}
      </div>
    )
  }

  // List / search view
  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-white">Memory</h2>
        {entries.length > 0 && (
          <p className="text-xs text-mountain-400 mt-1" data-testid="entry-count-summary">
            {describePage(entries.length, total)}
            {Object.keys(typeCounts).length > 0 && (
              <span>
                {' '}({Object.entries(typeCounts).map(([type, count], i) => (
                  <span key={type}>{i > 0 ? ', ' : ''}{count} {type}</span>
                ))})
              </span>
            )}
          </p>
        )}
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <input
          type="text"
          value={search}
          onChange={e => {
            setSearch(e.target.value)
            if (!e.target.value.trim()) { setSearchResults(null); setSearchTotal(null) }
          }}
          placeholder="Search memory entries..."
          className="flex-1 rounded-md border border-navy-600 bg-navy-900 px-3 py-2 text-sm text-white placeholder-mountain-500 focus:outline-none focus:border-brand-500"
        />
        <button
          type="submit"
          disabled={searchLoading || !search.trim()}
          className="px-4 py-2 text-sm font-medium rounded-md bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
        >
          Search
        </button>
      </form>

      {/* Type filter tabs */}
      <div className="flex items-center gap-1 mb-4" data-testid="type-filters">
        <button
          onClick={() => setTypeFilter('all')}
          className={`px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${
            typeFilter === 'all' ? 'bg-brand-600 text-white' : 'text-mountain-400 hover:text-white hover:bg-navy-700'
          }`}
        >
          All
        </button>
        {ENTRY_TYPES.map(type => (
          <button
            key={type}
            onClick={() => setTypeFilter(type)}
            className={`px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${
              typeFilter === type ? 'bg-brand-600 text-white' : 'text-mountain-400 hover:text-white hover:bg-navy-700'
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      {searchResults !== null ? (
        /* Search results */
        <div>
          {searchLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
            </div>
          ) : searchResults.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-mountain-400 mb-2">
                {searchTotal !== null && searchTotal > searchResults.length
                  ? `Showing ${searchResults.length} of ${searchTotal} results`
                  : `${searchTotal ?? searchResults.length} result${(searchTotal ?? searchResults.length) !== 1 ? 's' : ''}`}
              </p>
              {searchResults.map(result => (
                <button
                  key={result.id || result.path}
                  onClick={() => loadEntryContent(result)}
                  className="w-full text-left rounded-md border border-navy-700 bg-navy-900 p-3 hover:border-navy-500 transition-colors cursor-pointer"
                  data-testid="search-result"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-white">{result.title || result.path}</span>
                    <span className={`px-1.5 py-0.5 text-xs rounded-md border ${typeBadgeColor(result.entry_type)}`}>
                      {result.entry_type}
                    </span>
                    {result.score != null && (
                      <span className="text-xs text-mountain-500">score: {Number(result.score).toFixed(2)}</span>
                    )}
                  </div>
                  {result.headline && (
                    <p className="text-xs text-mountain-300">{renderHeadline(result.headline)}</p>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-mountain-500">No results found</p>
          )}
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
        </div>
      ) : filtered.length > 0 ? (
        /* Entry list */
        <div className="space-y-2" data-testid="entry-list">
          {filtered.map(entry => (
            <button
              key={entry.id}
              onClick={() => loadEntryContent(entry)}
              className="w-full text-left rounded-md border border-navy-700 bg-navy-900 p-3 hover:border-navy-500 transition-colors cursor-pointer"
              data-testid="entry-item"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-white">{entry.title || entry.path}</span>
                <span className={`px-1.5 py-0.5 text-xs rounded-md border ${typeBadgeColor(entry.entry_type)}`}>
                  {entry.entry_type}
                </span>
              </div>
              <p className="text-xs font-mono text-mountain-400">{entry.path}</p>
              <p className="text-xs text-mountain-500 mt-1">
                {new Date(entry.created_at).toLocaleString()}
              </p>
            </button>
          ))}
          {hasMore && (
            <button
              onClick={() => fetchEntries(true)}
              disabled={loadingMore}
              className="w-full rounded-md border border-navy-700 bg-navy-900 p-2 text-sm text-mountain-300 hover:border-navy-500 disabled:opacity-50 transition-colors cursor-pointer"
              data-testid="load-more"
            >
              {loadingMore ? 'Loading…' : `Load more (${(total! - entries.length).toLocaleString()} remaining)`}
            </button>
          )}
        </div>
      ) : (
        <p className="text-sm text-mountain-500" data-testid="empty-state">
          No memory entries yet. This agent hasn&apos;t created any knowledge.
        </p>
      )}
    </div>
  )
}
