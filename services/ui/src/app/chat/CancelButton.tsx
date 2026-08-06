'use client'

import { useState } from 'react'
import { Square } from 'lucide-react'

interface Props {
  threadId: string
  hasPending: boolean
  onCancelled?: () => void
}

export default function CancelButton({ threadId, hasPending, onCancelled }: Props) {
  const [cancelling, setCancelling] = useState(false)

  if (!hasPending) return null

  // Lowest-value of this sweep's four fixes, fixed anyway while in the file:
  // a failed cancel left the pending response running with nothing telling
  // the user it hadn't stopped, but nothing was believed-saved-and-lost —
  // the response just kept generating, same as if Cancel were never clicked.
  const handleCancel = async () => {
    setCancelling(true)
    try {
      const res = await fetch(`/api/chat/${threadId}/cancel`, { method: 'POST' })
      if (res.ok) {
        onCancelled?.()
      } else {
        alert('Could not cancel — the response may still be running')
      }
    } catch {
      alert('Could not cancel: the request did not complete')
    } finally {
      setCancelling(false)
    }
  }

  return (
    <button
      onClick={handleCancel}
      disabled={cancelling}
      className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded transition-colors disabled:opacity-50"
      data-testid="cancel-button"
      title="Cancel pending responses"
    >
      <Square size={12} />
      {cancelling ? 'Cancelling...' : 'Cancel'}
    </button>
  )
}
