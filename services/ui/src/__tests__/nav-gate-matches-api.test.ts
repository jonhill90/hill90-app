/**
 * A nav item's `adminOnly` flag must agree with what its page's API actually
 * requires.
 *
 * The Storage page is a MinIO bucket browser: it lists objects, uploads to an
 * arbitrary bucket and deletes by key. All three are admin on the API, and the
 * only `user`-level call in that router is the bucket-name list. The nav offered
 * it to every signed-in user anyway, so an ordinary user got a page that 403s.
 * That is the same mismatch as requiring admin on a route ordinary users reach,
 * pointing the other way — the page and its data have to agree.
 *
 * The negative cases matter more than the positive one. Marking Storage
 * `adminOnly` is a TIGHTENING, and the failure mode of a tightening is that it
 * spreads: Chat, Dashboard and Monitoring must stay open, because chat
 * attachment upload is now explicitly a `user`-level write and the monitoring
 * page reads the bucket list at `user`. Pinning only the Storage row would let
 * a later edit close those too and still pass.
 */
import { describe, it, expect } from 'vitest'
import { NAV_ITEMS, type NavItem, type NavLink } from '@/components/nav-items'

function flatten(items: NavItem[]): NavLink[] {
  return items.flatMap((item) =>
    item.type === 'group'
      // A child inside an adminOnly group is admin-gated whether or not it says
      // so itself — Sidebar.tsx filters the group before its children.
      ? item.children.map((c) => ({ ...c, adminOnly: c.adminOnly || item.adminOnly }))
      : [item],
  )
}

const byId = new Map(flatten(NAV_ITEMS).map((l) => [l.id, l]))

describe('nav gating matches what each page\'s API requires', () => {
  it('Storage is admin — listing objects, uploading and deleting all require it', () => {
    expect(byId.get('storage')?.adminOnly).toBe(true)
  })

  it('Secrets is admin — /admin/secrets is requireRole(admin) at the mount', () => {
    expect(byId.get('secrets')?.adminOnly).toBe(true)
  })

  it('Chat stays open — attachment upload is a user-level write', () => {
    // services/api/src/routes/storage.ts allows `user` to POST to the
    // chat-attachments bucket specifically. Closing this nav item would hide a
    // page that now works.
    expect(byId.get('chat')?.adminOnly).toBeFalsy()
  })

  it('Monitoring stays open — it reads the bucket list at user level', () => {
    expect(byId.get('monitoring')?.adminOnly).toBeFalsy()
  })

  it('Dashboard and Agents stay open', () => {
    expect(byId.get('dashboard')?.adminOnly).toBeFalsy()
    expect(byId.get('agents')?.adminOnly).toBeFalsy()
  })

  it('the tightening did not spread — most items are still open to everyone', () => {
    // A blunt guard against someone "securing" the nav by flagging everything,
    // which would pass every case above except this one.
    const all = flatten(NAV_ITEMS)
    const admin = all.filter((l) => l.adminOnly)
    expect(admin.length).toBeLessThan(all.length / 2)
    expect(all.length).toBeGreaterThan(10)
  })
})
