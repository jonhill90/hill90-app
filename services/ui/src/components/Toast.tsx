'use client'

import { useCallback, useState } from 'react'

/**
 * The one place this UI tells you an action did not work (#217).
 *
 * EXTRACTED, NOT INVENTED. `harness/secrets/SecretsClient.tsx` already had
 * exactly this — the same fixed corner, the same colours, the same 4s dismissal
 * — and used it correctly: success strictly after `res.ok`, error on the other
 * branch. Five write paths needed the same treatment, and copying that block
 * five times would have produced six implementations of one idea. So it moved
 * here and SecretsClient now uses it, leaving ONE.
 *
 * WHAT IT DOES NOT DO, deliberately: it does not retry, and it does not undo.
 * Every path that uses it already self-corrects — a refetch, a poll, a revert —
 * so the missing thing was never the recovery, it was being told. A toast that
 * offered to retry would be a second mechanism for something the page already
 * does.
 */
export interface ToastState {
  type: 'success' | 'error'
  message: string
}

export function useToast(): {
  toast: ToastState | null
  showToast: (type: ToastState['type'], message: string) => void
} {
  const [toast, setToast] = useState<ToastState | null>(null)
  const showToast = useCallback((type: ToastState['type'], message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 4000)
  }, [])
  return { toast, showToast }
}

export default function Toast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null
  return (
    <div
      role="status"
      data-testid={`toast-${toast.type}`}
      className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg text-sm shadow-lg border transition-opacity ${
        toast.type === 'success'
          ? 'bg-brand-900/80 text-brand-300 border-brand-700'
          : 'bg-red-900/80 text-red-300 border-red-700'
      }`}
    >
      {toast.message}
    </div>
  )
}

/**
 * The message for a failed write, from whatever the response actually said.
 *
 * The api's proxies return `{ error }` and, since #223, `{ error,
 * upstream_status }` for a body that would not parse. Reading it is the
 * difference between "Could not remove the key" and "Could not remove the key:
 * agent is running", and the second is the one that tells someone what to do.
 */
export async function failureMessage(action: string, res: Response): Promise<string> {
  let detail = `HTTP ${res.status}`
  try {
    const body = await res.json()
    if (body && typeof body.error === 'string') detail = body.error
  } catch {
    // A non-JSON body is not worth surfacing verbatim to a browser (#223); the
    // status is the part that is safe and useful.
  }
  return `${action}: ${detail}`
}
