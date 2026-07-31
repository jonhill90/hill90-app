# UI Component Architecture

*Next.js 16 frontend — component hierarchy, page patterns, auth, and API proxy.*

## Component Hierarchy

```
AppShell (server component)
├── TopBar (client)
│   ├── Mobile hamburger (md:hidden)
│   ├── HillLogo
│   ├── navExtra slot (breadcrumbs)
│   ├── NotificationBell + dropdown panel
│   └── AuthButtons
├── Sidebar (client, hidden md:flex)
│   ├── NAV_ITEMS mapping (nav-items.ts)
│   ├── Role-filtered links (adminOnly)
│   └── Collapse toggle (persisted to localStorage)
├── MobileDrawer (client, md:hidden)
│   ├── Same NAV_ITEMS mapping
│   ├── Escape/backdrop close
│   └── Auto-close on route change
├── {children} (page content)
└── Footer (conditional, hidden when noFooter=true)
```

## AppShell

- **File**: `components/AppShell.tsx` (server component)
- **Props**: `children`, `navExtra?`, `noFooter?`
- `noFooter=true` → `h-screen overflow-hidden` (used by chat for full-height streaming layout)
- `noFooter=false` → `min-h-screen` with copyright footer
- Inner layout: `flex flex-1 overflow-hidden min-h-0` → Sidebar + content column

## Navigation

- **Source of truth**: `components/nav-items.ts` — single `NAV_ITEMS` array
- **Types**: `NavLink` (href, icon, adminOnly?) | `NavGroup` (children[], icon, adminOnly?)
- **Items**:
  - Top-level: Home `/`, Dashboard `/dashboard`, Agents `/agents`, Chat `/chat`, Tasks `/tasks`, Knowledge `/harness/knowledge`
  - Harness group: Connections, Models, Skills, Dependencies (admin), Usage, Library, Storage, Monitoring, Workflows, Secrets (admin)
  - Docs group: API Docs (admin), Platform Docs (external link)
  - Admin group (adminOnly): Services
- **Icons**: lucide-react (tree-shaken named imports)

## Sidebar

- **File**: `components/Sidebar.tsx` (client component)
- Collapsible: `w-[220px]` expanded, `w-[60px]` collapsed
- Collapse state persisted to `localStorage` key `sidebar-collapsed`
- Group expansion persisted per-group as `nav-expanded-{id}`
- Active link: exact match on `/`, startsWith for other paths → `bg-brand-500/15 text-brand-400`
- Filters `adminOnly` items via `session.user.roles`

## TopBar

- **File**: `components/TopBar.tsx` (client component)
- Left: hamburger (mobile), logo, optional `navExtra` breadcrumb
- Right: notification bell (red dot badge for unread count), AuthButtons
- Notification dropdown: `w-80 max-h-96 overflow-y-auto`, close on Escape or click-outside

## MobileDrawer

- **File**: `components/MobileDrawer.tsx` (client component)
- Props: `open`, `onClose`
- Fixed overlay `z-40` + nav panel `w-[260px] z-50 bg-navy-900`
- Locks body scroll while open
- Auto-closes on route change (tracks `pathname` via useRef)

## Page Patterns

Every protected page follows the same structure:

```tsx
'use client'

import { useSession } from 'next-auth/react'
import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import SomeClient from './SomeClient'

export default function SomePage() {
  const { data: session, status } = useSession()

  if (status === 'loading') return <Spinner />
  if (!session) redirect('/api/auth/signin')

  return (
    <AppShell>
      <main className="flex-1 px-6 py-12 max-w-6xl mx-auto w-full">
        <SomeClient session={session as any} />
      </main>
    </AppShell>
  )
}
```

- Page is a thin `'use client'` wrapper — handles auth check and loading spinner
- Heavy logic lives in the `*Client.tsx` component (receives `session` prop)
- Session cast `as any` to access extended fields (`roles`, `accessToken`)
- Chat pages use `<AppShell noFooter>` for full-height layout

## Auth Patterns

### NextAuth v5 Configuration (`auth.ts`)

- **Provider**: Keycloak (env: `AUTH_KEYCLOAK_ID`, `AUTH_KEYCLOAK_SECRET`, `AUTH_KEYCLOAK_ISSUER`)
- **JWT callback**:
  - Initial sign-in: decodes access token, extracts `realm_roles` array
  - Persists `accessToken`, `idToken`, `refreshToken`, `accessTokenExpires`, `roles`
  - Refresh: calls Keycloak token endpoint with `grant_type: refresh_token`
  - On refresh failure: sets `error: "RefreshAccessTokenError"`, nulls tokens
- **Session callback**: populates `session.accessToken`, `session.user.roles`, `session.error`
- **Authorized callback**: protects `/dashboard/*`, `/agents/*`, `/chat/*`, `/harness/*`, `/admin/*`, `/docs/*`, `/profile/*`, `/settings/*`

### Middleware (`middleware.ts`)

- Checks for missing auth, refresh errors, or missing accessToken
- Redirects to `/api/auth/signin` on failure
- Matcher covers all protected route patterns

### Role Checks in Components

```tsx
const isAdmin = session.user?.roles?.includes('admin')
// Used for: conditional rendering, adminOnly nav filtering, action buttons
```

## API Proxy Pattern

### proxyToApi (`utils/api-proxy.ts`)

All `/api/*` routes are thin proxy layers forwarding to the backend API service.

- **Auth injection**: calls `auth()`, injects `Authorization: Bearer {accessToken}`
- **URL**: `${API_URL}${backendPath}` (default `API_URL`: `http://localhost:3000`)
- **Query params**: forwarded from incoming request
- **Content-Type**: preserved from incoming request
- **Timeout**: 30s for regular requests, none for SSE
- **SSE detection**: `sse: true` option OR `follow=true` query param
- **SSE response**: raw stream passthrough with `text/event-stream` headers
- **Error**: returns 502 `{ error: 'API request failed' }` on fetch failure

### Route File Pattern

```tsx
// app/api/agents/route.ts
import { proxyToApi } from '@/utils/api-proxy'

async function proxyRequest(req: NextRequest) {
  return proxyToApi(req, '/agents', { label: 'agents-proxy' })
}
export const GET = proxyRequest
export const POST = proxyRequest
```

Dynamic catch-all routes (`[...path]/route.ts`) join path segments:
```tsx
const pathStr = path.join('/')
return proxyToApi(req, `/agents/${pathStr}`, { label: 'agents-proxy' })
```

### Available Proxy Routes

| UI Route | Backend Path | Notes |
|----------|-------------|-------|
| `/api/agents` | `/agents` | CRUD + start/stop/restart |
| `/api/chat` | `/chat/threads` | Threads + messages + SSE stream |
| `/api/usage` | `/usage` | Stats with filters |
| `/api/user-models` | `/user-models` | User model config |
| `/api/model-policies` | `/model-policies` | Policy CRUD |
| `/api/provider-connections` | `/provider-connections` | Connection CRUD + validate |
| `/api/shared-knowledge` | `/shared-knowledge/*` | Collections, sources, search |
| `/api/skills` | `/skills` | Skill definitions |
| `/api/tools` | `/tools` | Tool definitions |
| `/api/container-profiles` | `/container-profiles` | Container presets |
| `/api/services/health` | `/health` | Service health check |
| `/api/storage` | `/storage` | MinIO bucket operations |
| `/api/tasks` | `/tasks` | Task management |

## Design Tokens

- **Backgrounds**: `navy-900` (deepest), `navy-800` (cards), `navy-700` (borders)
- **Text**: `white` (primary), `mountain-400` (secondary), `mountain-500` (tertiary)
- **Interactive**: `brand-600` (button), `brand-500` (hover), `brand-400` (links/active)
- **Card pattern**: `rounded-lg border border-navy-700 bg-navy-800 p-5`
- **Input pattern**: `border border-navy-600 bg-navy-900 focus:border-brand-500 focus:outline-none`
- **Spinner**: `h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin`

## Data Fetching Pattern

Client components use `useCallback` + `useEffect`:

```tsx
const fetchData = useCallback(async () => {
  const [aRes, bRes] = await Promise.all([fetch('/api/a'), fetch('/api/b')])
  if (aRes.ok) setA(await aRes.json())
  if (bRes.ok) setB(await bRes.json())
}, [])

useEffect(() => { fetchData() }, [fetchData])
```

- `Number()` coercion for Postgres numeric strings (e.g., `Number(usage?.total_cost_usd ?? 0)`)
- `Promise.all()` for concurrent independent requests
- `URLSearchParams` for query building with filters

## See Also

- [Architecture Overview](./overview.md)
- [Agent Harness Architecture](./agent-harness.md)
- Secrets Architecture — lives in the Hill90 infrastructure repository as `docs/architecture/secrets-model.md`; this application's own secret layout is in [secret-layout.md](../reference/secret-layout.md).
