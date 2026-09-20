# Guest Portal Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the portal owner choose one of three faithful visual themes — `tiles`, `cards`, `classic` — for every screen a guest sees, with adding a fourth theme costing one folder and one registry line.

**Architecture:** Device behaviour is extracted from the tiles into headless hooks, so a theme's components are pure presentation. Each theme is a folder exporting tokens, an icon resolver, and *optional* component overrides; a static registry maps id → theme. Tokens are emitted as CSS custom properties keyed off `data-theme` on `<html>`, which the server injects into the HTML it already rewrites — so the theme applies during HTML parse with no API call and no unthemed flash.

**Tech Stack:** TypeScript · React 19 · Tailwind 4 (CSS-first `@theme`) · Hono · `node:sqlite` · Zod 4 · vitest · Playwright. Icons: `@mdi/js` 7.4.47 and `@material-symbols/svg-400` 0.47.4 (both Apache-2.0).

**Spec:** `docs/superpowers/specs/2026-09-20-guest-portal-themes-design.md`

## Global Constraints

- **Theme ids are exactly `tiles`, `cards`, `classic`.** Neutral names, no trademark references in code or UI copy. Docs may say "inspired by".
- **`THEME_IDS` lives in `src/shared/themes.ts`** and is the single source of truth. The server validates against it; the web registry is typed from it. A test asserts registry keys === `THEME_IDS`.
- **The token set is CLOSED.** Every theme supplies every token; no theme invents its own. Needing a new token means extending the set for all themes — otherwise the default component set cannot render an arbitrary theme, which is the property that makes overrides optional.
- **`components` on a theme is optional.** A tokens-only theme must render correctly through the default set. This is the extensibility guarantee and is explicitly tested with a synthetic fixture theme.
- **No theme API endpoint.** The server injects `data-theme` into `index.html`.
- **Do not theme the admin surface.** It uses inline styles and only the owner sees it.
- Node >= 24. Imports inside `src/` use `.js` extensions; inside `test/` use `.ts`/`.tsx`.
- Biome: 2-space indent, single quotes, no semicolons. `pnpm lint`, `pnpm typecheck`, `pnpm vitest run` clean before every commit.
- Never add a `Co-Authored-By` trailer or any AI-attribution footer. Add new commits; never amend.
- **Do not start Docker containers, do not run `pnpm dev`/`dev:real`, and do not `sudo`.** A dev stack may be running against a real Home Assistant.
- `pnpm build` must run before `pnpm test:e2e`, and note `test/integration/routes-guest.test.ts` overwrites `dist/web/index.html` — so always `pnpm build` immediately before e2e.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/shared/themes.ts` | `THEME_IDS`, `ThemeId` — the contract between server and web |
| `src/web/themes/types.ts` | `Theme`, `ThemeTokens`, `TileProps`, `ShellProps` etc. |
| `src/web/themes/tokens.ts` | The closed token list + `tokensToCss()` |
| `src/web/themes/registry.ts` | id → theme map, `resolveTheme()` |
| `src/web/themes/default/*.tsx` | Token-only component set every theme inherits |
| `src/web/themes/classic/*` | `classic` theme (tokens, icons, components) |
| `src/web/themes/tiles/*` | `tiles` theme |
| `src/web/themes/cards/*` | `cards` theme |
| `src/web/hooks/useToggleDevice.ts` | Headless toggle behaviour |
| `src/web/hooks/useCoverDevice.ts` | Headless cover behaviour |
| `src/web/hooks/useLockDevice.ts` | Headless lock behaviour, incl. unlock confirmation |
| `src/web/components/ThemePicker.tsx` | Admin selector |
| `src/web/theme-previews/<id>.png` | Preview images **and** Playwright baselines |
| `test/e2e/theme-previews.spec.ts` | Captures the previews |

**Modified:** `src/server/store/settings.ts`, `src/server/app.ts`, `src/server/http/routes-admin.ts`, `src/shared/api.ts`, `src/web/api.ts`, `src/web/App.tsx`, `src/web/routes/Guest.tsx`, `src/web/index.css`, `src/web/routes/Admin.tsx`, `vite.config.ts`, `playwright.config.ts`, `package.json`.

**Deleted after migration:** `src/web/components/{ToggleTile,CoverTile,LockTile}.tsx` — their behaviour moves to hooks, their presentation to `themes/default/`.

---

# PHASE 1 — Infrastructure and `classic`

At the end of this phase the portal is themed end to end with one theme, and the picker works with a single option.

## Task 1: Shared theme ids and settings persistence

**Files:**
- Create: `src/shared/themes.ts`
- Modify: `src/server/store/settings.ts`
- Test: `test/unit/settings.test.ts` (append)

**Interfaces:**
- Produces: `THEME_IDS: readonly ['tiles','cards','classic']`, `type ThemeId`, `isThemeId(v: unknown): v is ThemeId`; `SettingsStore.getTheme(): ThemeId`, `SettingsStore.setTheme(id: ThemeId): void`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/settings.test.ts`:

```ts
  it('defaults the theme to classic', () => {
    expect(settings.getTheme()).toBe('classic')
  })

  it('persists a theme across store instances', () => {
    settings.setTheme('tiles')
    expect(new SettingsStore(db).getTheme()).toBe('tiles')
  })

  it('reads an unrecognised stored theme back as classic', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('portal_theme', 'bogus')").run()
    expect(settings.getTheme()).toBe('classic')
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/settings.test.ts`
Expected: FAIL — `settings.getTheme is not a function`.

- [ ] **Step 3: Create the shared contract**

Create `src/shared/themes.ts`:

```ts
// The set of themes the guest portal can render. This list is the contract
// between the two halves: the server validates against it and the web
// registry is typed from it. The server cannot import from src/web without
// pulling the client bundle into the server build, so it lives here.
export const THEME_IDS = ['tiles', 'cards', 'classic'] as const

export type ThemeId = (typeof THEME_IDS)[number]

export const DEFAULT_THEME_ID: ThemeId = 'classic'

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}
```

- [ ] **Step 4: Add the store methods**

In `src/server/store/settings.ts`, add the import and key, then the two methods alongside `getPortalEnabled`:

```ts
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from '../../shared/themes.js'
```

```ts
const KEY_PORTAL_THEME = 'portal_theme'
```

```ts
  getTheme(): ThemeId {
    // An absent or unrecognised value reads back as the default rather than
    // throwing: a row naming a theme that has since been deleted must degrade,
    // not take the portal down.
    const stored = this.read(KEY_PORTAL_THEME)
    return isThemeId(stored) ? stored : DEFAULT_THEME_ID
  }

  setTheme(id: ThemeId): void {
    this.write(KEY_PORTAL_THEME, id)
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run test/unit/settings.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
git add src/shared/themes.ts src/server/store/settings.ts test/unit/settings.test.ts
git commit -m "feat: persist the selected guest portal theme"
```

---

## Task 2: Inject the theme into the HTML, and fix the root path

**Files:**
- Modify: `src/server/app.ts`
- Test: `test/integration/routes-guest.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `settings.getTheme()` (Task 1).
- Produces: every HTML response carries `<html data-theme="…">` and `<base href="…">`, including `GET /`.

**Why this task exists.** `app.ts` registers `serveStatic({ root: './dist/web' })` and the SPA fallback both on `/*`. `serveStatic` resolves `/` to `index.html` and answers first, so the fallback never runs for the root URL. Verified against a running server:

```
GET /admin  →  <base href="/">   (fallback ran)
GET /       →  no base href      (serveStatic answered)
```

That is latent today because the built HTML uses relative `./assets/…` paths. But `/` is the URL every guest opens, so injecting the theme only in the fallback would leave the guest surface unthemed while `/admin` worked.

- [ ] **Step 1: Write the failing test**

Append to `test/integration/routes-guest.test.ts`. Note the existing SPA test writes a stub `index.html` into `dist/web`; reuse that approach so this test does not depend on a real build.

```ts
  describe('HTML injection', () => {
    async function writeStubIndex(): Promise<void> {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync('/home/andm/workspace/ha-guest-portal/dist/web', { recursive: true })
      writeFileSync(
        '/home/andm/workspace/ha-guest-portal/dist/web/index.html',
        '<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <title>t</title>\n  </head>\n  <body></body>\n</html>',
      )
    }

    it('injects data-theme and base href on /admin', async () => {
      await writeStubIndex()
      const res = await fetch(`${baseUrl}/admin`)
      const html = await res.text()

      expect(html).toContain('<base href="/">')
      expect(html).toContain('data-theme="classic"')
    })

    it('injects data-theme and base href on the root path too', async () => {
      await writeStubIndex()
      const res = await fetch(`${baseUrl}/`)
      const html = await res.text()

      // Regression guard: serveStatic used to answer / before the fallback,
      // so the root URL — the one every guest opens — received neither.
      expect(html).toContain('<base href="/">')
      expect(html).toContain('data-theme="classic"')
    })

    it('reflects the stored theme', async () => {
      await writeStubIndex()
      settings.setTheme('tiles')
      const res = await fetch(`${baseUrl}/`)
      expect(await res.text()).toContain('data-theme="tiles"')
    })
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/integration/routes-guest.test.ts -t "HTML injection"`
Expected: FAIL — the `/admin` case fails on `data-theme`, and the root case fails on both assertions.

- [ ] **Step 3: Extract the injection into one function**

In `src/server/app.ts`, above `createApp`, add:

```ts
/**
 * Read index.html and inject the two things the client cannot know for itself:
 * the ingress base path, and the active theme.
 *
 * The theme lands on <html> rather than in a <meta> so the CSS variable block
 * keyed off [data-theme] applies during HTML parse, before React loads. That is
 * what makes the portal render themed on first paint with no API call.
 *
 * Returns null when index.html is missing (an unbuilt checkout).
 */
function renderIndexHtml(deps: Deps, baseHref: string): string | null {
  let html: string
  try {
    html = readFileSync('./dist/web/index.html', 'utf-8')
  } catch {
    return null
  }

  const normalizedBase = baseHref.endsWith('/') ? baseHref : `${baseHref}/`

  return html
    .replace(/(<head[^>]*>)/i, `$1\n    <base href="${normalizedBase}">`)
    .replace(/<html/i, `<html data-theme="${deps.settings.getTheme()}"`)
}

function baseHrefFor(c: Context<Env>, deps: Deps): string {
  const remoteAddress = c.env.incoming.socket.remoteAddress
  const isIngress = deps.cfg.ingressPort && isFromSupervisor(remoteAddress)
  return isIngress ? (c.req.header('x-ingress-path') ?? '/') : '/'
}
```

Add `import type { Context } from 'hono'` if not already present.

- [ ] **Step 4: Serve `/` explicitly, before serveStatic**

In `createApp`, immediately **before** the `app.use('/*', serveStatic(...))` line:

```ts
  // serveStatic resolves / to index.html and would answer before the SPA
  // fallback, so the root URL would never be injected. Handle it explicitly.
  app.get('/', (c) => {
    const html = renderIndexHtml(deps, baseHrefFor(c, deps))
    return html === null ? c.notFound() : c.html(html)
  })
```

- [ ] **Step 5: Make the fallback use the same function**

Replace the body of the existing SPA fallback's `try` block so it calls `renderIndexHtml` instead of duplicating the read-and-replace:

```ts
  app.use('/*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.notFound()
    }

    const html = renderIndexHtml(deps, baseHrefFor(c, deps))
    return html === null ? c.notFound() : c.html(html)
  })
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm vitest run test/integration/routes-guest.test.ts`
Expected: PASS, including the pre-existing "serves SPA index.html for non-API paths" test.

- [ ] **Step 7: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
git add src/server/app.ts test/integration/routes-guest.test.ts
git commit -m "feat: inject the active theme into index.html

Also fixes the root path, which serveStatic answered before the SPA
fallback could inject <base href> — so GET / received neither the base
path nor the theme."
```

---

## Task 3: Admin theme routes

**Files:**
- Modify: `src/shared/api.ts`, `src/server/http/routes-admin.ts`, `src/web/api.ts`
- Test: `test/integration/routes-admin.test.ts` (append), `test/unit/api-schemas.test.ts` (append)

**Interfaces:**
- Consumes: `THEME_IDS`, `isThemeId` (Task 1).
- Produces: `GET /api/admin/portal` response gains `theme`; `PUT /api/admin/theme {theme}` → `{theme}`. Client: `putAdminTheme(theme: ThemeId): Promise<ApiResult<void>>`; `getAdminPortal()` result gains `theme: ThemeId`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/api-schemas.test.ts`:

```ts
describe('theme schemas', () => {
  it('requires theme on the admin portal response', () => {
    expect(
      AdminPortalResponse.safeParse({
        enabled: true,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown theme id', () => {
    expect(AdminThemePutRequest.safeParse({ theme: 'bogus' }).success).toBe(false)
  })

  it('accepts each known theme id', () => {
    for (const id of ['tiles', 'cards', 'classic']) {
      expect(AdminThemePutRequest.parse({ theme: id }).theme).toBe(id)
    }
  })
})
```

Append to `test/integration/routes-admin.test.ts`:

```ts
  describe('theme routes', () => {
    it('reports the current theme on the portal route', async () => {
      const res = await fetch(`${baseUrl}/api/admin/portal`, { headers: { cookie: adminCookie } })
      expect((await res.json()).theme).toBe('classic')
    })

    it('sets a theme', async () => {
      const res = await fetch(`${baseUrl}/api/admin/theme`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ theme: 'tiles' }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ theme: 'tiles' })
      expect(settings.getTheme()).toBe('tiles')
    })

    it('rejects an unknown theme and leaves the stored value alone', async () => {
      const res = await fetch(`${baseUrl}/api/admin/theme`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ theme: 'bogus' }),
      })

      expect(res.status).toBe(400)
      expect(settings.getTheme()).toBe('classic')
    })

    it('refuses a guest', async () => {
      const res = await fetch(`${baseUrl}/api/admin/theme`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: guestCookie },
        body: JSON.stringify({ theme: 'tiles' }),
      })
      expect(res.status).toBe(403)
    })

    it('refuses an anonymous request', async () => {
      const res = await fetch(`${baseUrl}/api/admin/theme`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: 'tiles' }),
      })
      expect(res.status).toBe(401)
    })
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/unit/api-schemas.test.ts test/integration/routes-admin.test.ts`
Expected: FAIL — `AdminThemePutRequest` is not exported; the theme routes 404.

- [ ] **Step 3: Add the schemas**

In `src/shared/api.ts`, import the ids and extend:

```ts
import { THEME_IDS } from './themes.js'
```

```ts
export const AdminPortalResponse = z.object({
  enabled: z.boolean(),
  integrationToken: z.string(),
  portalId: z.string(),
  theme: z.enum(THEME_IDS),
})

export const AdminThemePutRequest = z.object({
  theme: z.enum(THEME_IDS),
})
```

- [ ] **Step 4: Add the routes**

In `src/server/http/routes-admin.ts`, extend the import to include `AdminThemePutRequest`, add `theme: settings.getTheme()` to the object passed to `AdminPortalResponse.parse` in the existing `GET /api/admin/portal`, then append:

```ts
  // PUT /api/admin/theme - choose the guest-facing theme
  app.put('/api/admin/theme', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = AdminThemePutRequest.safeParse(body)
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0]
      return c.json({ error: firstIssue ? firstIssue.message : 'Invalid request' }, 400)
    }

    settings.setTheme(parseResult.data.theme)

    return c.json({ theme: parseResult.data.theme })
  })
```

- [ ] **Step 5: Add the client function**

In `src/web/api.ts`, append (matching `putAdminPortal`'s shape exactly, including the 401 callback):

```ts
export async function putAdminTheme(theme: ThemeId): Promise<ApiResult<void>> {
  const response = await fetch('/api/admin/theme', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
    credentials: 'same-origin',
  })

  if (!response.ok) {
    if (response.status === 401 && unauthorizedCallback !== null) {
      unauthorizedCallback()
    }
    return { ok: false, status: response.status }
  }

  return { ok: true, data: undefined }
}
```

Import `ThemeId` from `@shared/themes.js`. Widen `getAdminPortal`'s return type to include `theme: ThemeId`.

- [ ] **Step 6: Run to verify they pass**

Run: `pnpm vitest run`
Expected: PASS. Existing tests asserting the `GET /api/admin/portal` body shape will need `theme: 'classic'` added — extend them, do not loosen them to `toMatchObject`.

- [ ] **Step 7: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
git add src/shared/api.ts src/server/http/routes-admin.ts src/web/api.ts test
git commit -m "feat: add admin routes for selecting the guest theme"
```

---

## Task 4: Extract device behaviour into headless hooks

**Files:**
- Create: `src/web/hooks/useToggleDevice.ts`, `src/web/hooks/useCoverDevice.ts`, `src/web/hooks/useLockDevice.ts`
- Modify: `src/web/components/ToggleTile.tsx`, `CoverTile.tsx`, `LockTile.tsx`
- Test: `test/unit/device-hooks.test.tsx` (create)

**Interfaces:**
- Produces:

```ts
type ToggleDevice = {
  isOn: boolean
  isStale: boolean
  pending: boolean
  error: string | null
  label: string
  stateText: string            // 'On' | 'Off' | 'Unknown' | 'Updating...'
  canActivate: boolean         // false when no allowed action applies
  activate: () => void
}
function useToggleDevice(device: Device, disabled: boolean): ToggleDevice

type CoverDevice = {
  isStale: boolean; pending: boolean; error: string | null
  label: string; stateText: string
  canOpen: boolean; canClose: boolean; canStop: boolean
  open: () => void; close: () => void; stop: () => void
}
function useCoverDevice(device: Device, disabled: boolean): CoverDevice

type LockDevice = {
  isLocked: boolean; isStale: boolean; pending: boolean; error: string | null
  label: string; stateText: string
  canLock: boolean; canUnlock: boolean
  unlockConfirmPending: boolean      // true while awaiting the confirm tap
  lock: () => void
  requestUnlock: () => void          // first tap arms, second performs
  cancelUnlock: () => void
}
function useLockDevice(device: Device, disabled: boolean): LockDevice
```

**Why this task exists.** The existing tiles mix behaviour with presentation: `ToggleTile` owns optimistic state, a 5-second timeout backstop, clearing on disconnect, and choosing between `turn_on`/`turn_off`/`toggle` based on `allowedActions`. `LockTile` owns a 5-second unlock confirmation. Three faithful themes reimplementing that would triplicate the logic and its bugs. Extracting it first makes each theme's components pure presentation.

This is a **refactor with no behaviour change**: the existing tiles keep working and their existing tests keep passing unmodified. That is the safety property — do not edit `test/unit/guest-ui.test.tsx` or any existing tile test in this task. If one fails, the extraction changed behaviour and is wrong.

- [ ] **Step 1: Write the failing test**

Create `test/unit/device-hooks.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { Device } from '@shared/api.js'
import { useToggleDevice } from '../../src/web/hooks/useToggleDevice.ts'
import { useLockDevice } from '../../src/web/hooks/useLockDevice.ts'
import * as api from '../../src/web/api.ts'

vi.mock('../../src/web/api.ts')

function toggleDevice(overrides: Partial<Device> = {}): Device {
  return {
    entityId: 'light.porch',
    label: 'Porch',
    domain: 'light',
    allowedActions: ['turn_on', 'turn_off'],
    sortOrder: 0,
    state: { state: 'off', attributes: {}, stale: false },
    ...overrides,
  }
}

describe('useToggleDevice', () => {
  beforeEach(() => {
    vi.mocked(api.performAction).mockResolvedValue({ ok: true, data: undefined })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports off state', () => {
    const { result } = renderHook(() => useToggleDevice(toggleDevice(), false))
    expect(result.current.isOn).toBe(false)
    expect(result.current.stateText).toBe('Off')
  })

  it('calls turn_on when off', async () => {
    const { result } = renderHook(() => useToggleDevice(toggleDevice(), false))
    act(() => result.current.activate())
    await waitFor(() => expect(api.performAction).toHaveBeenCalledWith('light.porch', 'turn_on'))
  })

  it('falls back to toggle when only toggle is allowed', async () => {
    const d = toggleDevice({ allowedActions: ['toggle'] })
    const { result } = renderHook(() => useToggleDevice(d, false))
    act(() => result.current.activate())
    await waitFor(() => expect(api.performAction).toHaveBeenCalledWith('light.porch', 'toggle'))
  })

  it('shows the optimistic state immediately', async () => {
    const { result } = renderHook(() => useToggleDevice(toggleDevice(), false))
    act(() => result.current.activate())
    await waitFor(() => expect(result.current.isOn).toBe(true))
  })

  it('reverts the optimistic state when the call fails', async () => {
    vi.mocked(api.performAction).mockResolvedValue({ ok: false, status: 503 })
    const { result } = renderHook(() => useToggleDevice(toggleDevice(), false))
    act(() => result.current.activate())
    await waitFor(() => expect(result.current.isOn).toBe(false))
    expect(result.current.error).toBe('Action failed')
  })

  it('reports canActivate false when no action applies', () => {
    const d = toggleDevice({ allowedActions: [] })
    const { result } = renderHook(() => useToggleDevice(d, false))
    expect(result.current.canActivate).toBe(false)
  })

  it('shows Unknown when stale', () => {
    const d = toggleDevice({ state: { state: 'on', attributes: {}, stale: true } })
    const { result } = renderHook(() => useToggleDevice(d, false))
    expect(result.current.stateText).toBe('Unknown')
  })
})

describe('useLockDevice', () => {
  beforeEach(() => {
    vi.mocked(api.performAction).mockResolvedValue({ ok: true, data: undefined })
  })

  function lockDevice(): Device {
    return {
      entityId: 'lock.front',
      label: 'Front Door',
      domain: 'lock',
      allowedActions: ['lock', 'unlock'],
      sortOrder: 0,
      state: { state: 'locked', attributes: {}, stale: false },
    }
  }

  it('arms on the first unlock request rather than unlocking', () => {
    const { result } = renderHook(() => useLockDevice(lockDevice(), false))
    act(() => result.current.requestUnlock())
    expect(result.current.unlockConfirmPending).toBe(true)
    expect(api.performAction).not.toHaveBeenCalled()
  })

  it('unlocks on the second request', async () => {
    const { result } = renderHook(() => useLockDevice(lockDevice(), false))
    act(() => result.current.requestUnlock())
    act(() => result.current.requestUnlock())
    await waitFor(() => expect(api.performAction).toHaveBeenCalledWith('lock.front', 'unlock'))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/device-hooks.test.tsx`
Expected: FAIL — cannot resolve `useToggleDevice.ts`.

- [ ] **Step 3: Write `useToggleDevice`**

Create `src/web/hooks/useToggleDevice.ts` by moving the state, the effect and `handleClick` out of `ToggleTile.tsx` verbatim — the optimistic state, the `deviceStateRef` comparison, the disconnect clear, the 5-second timeout backstop and the `turn_on`/`turn_off`/`toggle` selection. Return the `ToggleDevice` shape from the Interfaces block. Derive `stateText` as: stale → `'Unknown'`; pending → `'Updating...'`; else `isOn ? 'On' : 'Off'`. Derive `canActivate` from `canTurnOn || canTurnOff || canToggle`.

- [ ] **Step 4: Write `useCoverDevice` and `useLockDevice`**

Same move from `CoverTile.tsx` and `LockTile.tsx`. `useLockDevice` keeps the `UNLOCK_CONFIRM_TIMEOUT_MS = 5000` behaviour: `requestUnlock` arms `unlockConfirmPending` on the first call and performs the unlock on the second, auto-cancelling after the timeout.

- [ ] **Step 5: Rewrite the three tiles to consume the hooks**

Each tile keeps its existing markup and Tailwind classes exactly, but sources its state from the hook rather than owning it. The rendered output must be byte-identical.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm vitest run`
Expected: PASS, with **no edits to any existing tile test**. A failure here means the extraction changed behaviour.

- [ ] **Step 7: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
git add src/web/hooks test/unit/device-hooks.test.tsx src/web/components
git commit -m "refactor: extract device behaviour into headless hooks

Themes supply their own tile components, so the optimistic-update and
unlock-confirmation logic must live somewhere they can share rather than
being reimplemented three times."
```

---

## Task 5: Theme contract, tokens and registry

**Files:**
- Create: `src/web/themes/types.ts`, `src/web/themes/tokens.ts`, `src/web/themes/registry.ts`
- Test: `test/unit/theme-registry.test.ts` (create)

**Interfaces:**
- Consumes: `THEME_IDS`, `ThemeId`, `DEFAULT_THEME_ID` (Task 1); the hook types (Task 4).
- Produces: `Theme`, `ThemeTokens`, `TOKEN_NAMES`, `tokensToCss(tokens)`, `resolveTheme(id: string): Theme`, `listThemes(): Theme[]`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/theme-registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '../../src/shared/themes.ts'
import { listThemes, resolveTheme } from '../../src/web/themes/registry.ts'
import { TOKEN_NAMES } from '../../src/web/themes/tokens.ts'

describe('theme registry', () => {
  it('resolves every declared id', () => {
    for (const id of THEME_IDS) {
      expect(resolveTheme(id).id).toBe(id)
    }
  })

  it('falls back to classic for an unknown id rather than throwing', () => {
    expect(resolveTheme('bogus').id).toBe('classic')
  })

  it('registry keys match THEME_IDS exactly', () => {
    expect(listThemes().map((t) => t.id).sort()).toEqual([...THEME_IDS].sort())
  })

  it('every theme declares both modes and an icon resolver', () => {
    for (const theme of listThemes()) {
      expect(theme.tokens.light).toBeDefined()
      expect(theme.tokens.dark).toBeDefined()
      expect(typeof theme.icon).toBe('function')
      expect(theme.name.length).toBeGreaterThan(0)
    }
  })

  it('every theme supplies every token in both modes', () => {
    for (const theme of listThemes()) {
      for (const mode of ['light', 'dark'] as const) {
        for (const name of TOKEN_NAMES) {
          expect(theme.tokens[mode][name], `${theme.id}.${mode}.${name}`).toBeTruthy()
        }
      }
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/theme-registry.test.ts`
Expected: FAIL — cannot resolve `registry.ts`.

- [ ] **Step 3: Define the closed token set**

Create `src/web/themes/tokens.ts`:

```ts
// The token set is CLOSED. Every theme supplies every token; no theme invents
// its own. A theme needing a value outside this list is a signal to extend the
// list for all themes — otherwise the default component set cannot render an
// arbitrary theme, which is the property that makes component overrides optional.
export const TOKEN_NAMES = [
  'appBg',
  'surface',
  'surfaceRaised',
  'surfaceActive',
  'text',
  'textMuted',
  'accent',
  'accentText',
  'danger',
  'border',
  'tileRadius',
  'tileGap',
  'tilePadding',
  'fontFamily',
  'shadow',
] as const

export type TokenName = (typeof TOKEN_NAMES)[number]
export type ThemeTokens = Record<TokenName, string>

/** Emit a token set as CSS custom property declarations. */
export function tokensToCss(tokens: ThemeTokens): string {
  return TOKEN_NAMES.map((name) => `  --${name}: ${tokens[name]};`).join('\n')
}
```

- [ ] **Step 4: Define the contract**

Create `src/web/themes/types.ts`:

```ts
import type { ComponentType, ReactElement } from 'react'
import type { Device, Role } from '@shared/api.js'
import type { ThemeId } from '@shared/themes.js'
import type { SupportedDomain } from '@shared/devices.js'
import type { ThemeTokens } from './tokens.js'

export type TileProps = { device: Device; disabled: boolean }
export type ShellProps = { children: ReactElement | ReactElement[]; onLogout: () => void; loggingOut: boolean }
export type LoginProps = { onSuccess: (role: Role) => void }
export type DisabledProps = { onRetry: () => void }

export type Theme = {
  id: ThemeId
  name: string
  tokens: { light: ThemeTokens; dark: ThemeTokens }
  icon: (domain: SupportedDomain, state: string) => ReactElement
  /**
   * Optional. A theme that supplies nothing here renders through the default
   * component set using its tokens alone — that is what keeps a new theme to
   * one token file rather than a component set.
   */
  components?: {
    Shell?: ComponentType<ShellProps>
    ToggleTile?: ComponentType<TileProps>
    CoverTile?: ComponentType<TileProps>
    LockTile?: ComponentType<TileProps>
    Login?: ComponentType<LoginProps>
    Disabled?: ComponentType<DisabledProps>
  }
}
```

- [ ] **Step 5: Write the registry**

Create `src/web/themes/registry.ts`:

```ts
import { DEFAULT_THEME_ID } from '@shared/themes.js'
import type { Theme } from './types.js'
import classic from './classic/index.js'

// Static registry: every theme ships in the bundle. This map's value type is
// the single swap point for lazy loading — changing it to
// `() => Promise<Theme>` is a localised change, worth making at eight themes
// rather than three.
const THEMES: Record<string, Theme> = {
  classic,
}

export function resolveTheme(id: string): Theme {
  // An unrecognised id degrades to the default rather than white-screening:
  // a settings row may name a theme that has since been removed.
  return THEMES[id] ?? THEMES[DEFAULT_THEME_ID]!
}

export function listThemes(): Theme[] {
  return Object.values(THEMES)
}
```

Note: this file gains one import and one map entry per theme in Tasks 8 and 10. The registry test will fail until all three exist — that is expected and is closed out in Task 10's final step.

- [ ] **Step 6: Run the focused test**

Run: `pnpm vitest run test/unit/theme-registry.test.ts`
Expected: the `resolveTheme('classic')` and fallback cases pass; `registry keys match THEME_IDS` FAILS because only `classic` is registered. Leave it failing and mark it:

```ts
  // Phase 1 registers only `classic`; tiles and cards arrive in phases 2 and 3.
  it.fails('registry keys match THEME_IDS exactly', () => {
```

Use `it.fails` — **not** `it.skip`. When Task 10 registers the third theme this test starts passing, `it.fails` turns an unexpected pass into a failure, and whoever finishes Phase 3 is forced to remove the marker. A skip would stay green forever and silently retire the assertion.

- [ ] **Step 7: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
git add src/web/themes test/unit/theme-registry.test.ts
git commit -m "feat: add the theme contract, closed token set and registry"
```

---

## Task 6: The default component set

**Files:**
- Create: `src/web/themes/default/{Shell,ToggleTile,CoverTile,LockTile,Login,Disabled}.tsx`, `src/web/themes/default/index.ts`
- Test: `test/unit/theme-default-components.test.tsx` (create)

**Interfaces:**
- Consumes: the hooks (Task 4), `TileProps`/`ShellProps`/`LoginProps`/`DisabledProps` (Task 5).
- Produces: `DEFAULT_COMPONENTS` — a complete set satisfying every slot in `Theme['components']`.

**Why this task exists.** This is the extensibility guarantee made concrete: a theme supplying only tokens and an icon must still render a coherent portal. Every component here reads *only* CSS custom properties, never a hardcoded colour.

- [ ] **Step 1: Write the failing test**

Create `test/unit/theme-default-components.test.tsx`. The critical part is the synthetic fixture theme — it must not be one of the three real ones, because they all override everything and would prove nothing:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Device } from '@shared/api.js'
import { DEFAULT_COMPONENTS } from '../../src/web/themes/default/index.ts'
import { TOKEN_NAMES } from '../../src/web/themes/tokens.ts'
import type { Theme } from '../../src/web/themes/types.ts'

vi.mock('../../src/web/api.ts')

// A theme that supplies ONLY tokens and an icon — no component overrides.
// This is the extensibility contract under test.
const fixtureTheme: Theme = {
  id: 'classic',
  name: 'Fixture',
  tokens: {
    light: Object.fromEntries(TOKEN_NAMES.map((n) => [n, 'red'])) as Theme['tokens']['light'],
    dark: Object.fromEntries(TOKEN_NAMES.map((n) => [n, 'blue'])) as Theme['tokens']['dark'],
  },
  icon: () => <svg data-testid="fixture-icon" />,
}

function device(domain: string, overrides: Partial<Device> = {}): Device {
  return {
    entityId: `${domain}.thing`,
    label: 'Thing',
    domain,
    allowedActions: domain === 'lock' ? ['lock', 'unlock'] : domain === 'cover' ? ['open_cover', 'close_cover'] : ['turn_on', 'turn_off'],
    sortOrder: 0,
    state: { state: domain === 'lock' ? 'locked' : 'off', attributes: {}, stale: false },
    ...overrides,
  }
}

describe('default component set', () => {
  it('has a component for every slot', () => {
    for (const slot of ['Shell', 'ToggleTile', 'CoverTile', 'LockTile', 'Login', 'Disabled'] as const) {
      expect(DEFAULT_COMPONENTS[slot], slot).toBeDefined()
    }
  })

  it('renders a toggle tile for a tokens-only theme', () => {
    const { ToggleTile } = DEFAULT_COMPONENTS
    render(<ToggleTile device={device('light')} disabled={false} />)
    expect(screen.getByText('Thing')).toBeTruthy()
  })

  it('renders a cover tile for a tokens-only theme', () => {
    const { CoverTile } = DEFAULT_COMPONENTS
    render(<CoverTile device={device('cover')} disabled={false} />)
    expect(screen.getByText('Thing')).toBeTruthy()
  })

  it('renders a lock tile for a tokens-only theme', () => {
    const { LockTile } = DEFAULT_COMPONENTS
    render(<LockTile device={device('lock')} disabled={false} />)
    expect(screen.getByText('Thing')).toBeTruthy()
  })

  it('uses no hardcoded colours — every colour comes from a token', () => {
    // Guards the property that makes overrides optional: if a default
    // component hardcodes a colour, a tokens-only theme cannot restyle it.
    const { readFileSync, readdirSync } = require('node:fs')
    const dir = 'src/web/themes/default'
    for (const f of readdirSync(dir).filter((f: string) => f.endsWith('.tsx'))) {
      const src = readFileSync(`${dir}/${f}`, 'utf-8')
      expect(src, `${f} uses a Tailwind palette colour`).not.toMatch(
        /\b(bg|text|border)-(gray|blue|red|green|yellow|indigo|purple|pink|slate|zinc)-\d{2,3}\b/,
      )
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/theme-default-components.test.tsx`
Expected: FAIL — cannot resolve `default/index.ts`.

- [ ] **Step 3: Write the default components**

Each consumes its hook and styles exclusively via `var(--token)` through Tailwind arbitrary values. `ToggleTile` for reference:

```tsx
import type { ReactElement } from 'react'
import { useToggleDevice } from '../../hooks/useToggleDevice.js'
import type { TileProps } from '../types.js'

export function ToggleTile({ device, disabled }: TileProps): ReactElement {
  const d = useToggleDevice(device, disabled)

  if (!d.canActivate) {
    return (
      <div className="p-[var(--tilePadding)] rounded-[var(--tileRadius)] bg-[var(--surface)] text-[var(--text)]">
        <div className="font-semibold">{d.label}</div>
        <div className="text-sm text-[var(--textMuted)] mt-1">No actions available</div>
      </div>
    )
  }

  return (
    <div className="rounded-[var(--tileRadius)] bg-[var(--surface)] shadow-[var(--shadow)]">
      <button
        type="button"
        onClick={d.activate}
        disabled={d.pending || disabled}
        aria-label={d.label}
        aria-pressed={d.isOn}
        className={`w-full p-[var(--tilePadding)] rounded-[var(--tileRadius)] text-left transition-colors disabled:cursor-not-allowed ${
          d.isOn ? 'bg-[var(--accent)] text-[var(--accentText)]' : 'bg-[var(--surface)] text-[var(--text)]'
        }`}
      >
        <div className="font-semibold">{d.label}</div>
        <div className="text-sm opacity-80 mt-1">{d.stateText}</div>
      </button>
      {d.error !== null && (
        <div className="text-sm text-[var(--danger)] px-[var(--tilePadding)] pb-2">{d.error}</div>
      )}
    </div>
  )
}
```

Write `CoverTile`, `LockTile`, `Shell`, `Login` and `Disabled` in the same idiom, porting the markup and copy from the current `src/web/components/` and `src/web/routes/` files but replacing every palette colour with a token. `Shell` renders the header, the logout button and the device grid container. `Disabled` keeps the existing reassuring copy verbatim — it must not read as an error.

`src/web/themes/default/index.ts` exports them as `DEFAULT_COMPONENTS`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run test/unit/theme-default-components.test.tsx`
Expected: PASS, including the no-hardcoded-colours check.

- [ ] **Step 5: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
git add src/web/themes/default test/unit/theme-default-components.test.tsx
git commit -m "feat: add the token-only default component set"
```

---

## Task 7: The `classic` theme

**Files:**
- Create: `src/web/themes/classic/{index.ts,tokens.ts,icons.tsx,ToggleTile.tsx,CoverTile.tsx,LockTile.tsx,Login.tsx,Disabled.tsx}`
- Modify: `package.json` (add `@mdi/js`)
- Test: `test/unit/theme-classic.test.tsx` (create)

**Interfaces:**
- Produces: default export `Theme` with `id: 'classic'`, `name: 'Classic'`, full `components`.

- [ ] **Step 1: Add the icon dependency**

Run: `pnpm add @mdi/js@7.4.47`

`@mdi/js` exports SVG path strings as named constants, so named imports tree-shake. This is the icon set Home Assistant itself uses, which is why `classic` can be genuinely accurate rather than a lookalike.

- [ ] **Step 2: Write the failing test**

Create `test/unit/theme-classic.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import classic from '../../src/web/themes/classic/index.ts'

vi.mock('../../src/web/api.ts')

describe('classic theme', () => {
  it('declares its identity and both modes', () => {
    expect(classic.id).toBe('classic')
    expect(classic.name).toBe('Classic')
    expect(classic.tokens.light.accent).toBeTruthy()
    expect(classic.tokens.dark.accent).toBeTruthy()
  })

  it('resolves an icon per supported domain', () => {
    for (const domain of ['light', 'switch', 'fan', 'input_boolean', 'cover', 'lock'] as const) {
      const { container } = render(classic.icon(domain, 'on'))
      expect(container.querySelector('svg'), domain).toBeTruthy()
    }
  })

  it('overrides every component slot', () => {
    for (const slot of ['Shell', 'ToggleTile', 'CoverTile', 'LockTile', 'Login', 'Disabled'] as const) {
      expect(classic.components?.[slot], slot).toBeDefined()
    }
  })

  it('renders a lock tile with the device label', () => {
    const LockTile = classic.components!.LockTile!
    render(
      <LockTile
        device={{
          entityId: 'lock.front', label: 'Front Door', domain: 'lock',
          allowedActions: ['lock', 'unlock'], sortOrder: 0,
          state: { state: 'locked', attributes: {}, stale: false },
        }}
        disabled={false}
      />,
    )
    expect(screen.getByText('Front Door')).toBeTruthy()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run test/unit/theme-classic.test.tsx`
Expected: FAIL — cannot resolve `classic/index.ts`.

- [ ] **Step 4: Write the tokens**

Create `src/web/themes/classic/tokens.ts`. These are Home Assistant's own palette values:

```ts
import type { ThemeTokens } from '../tokens.js'

export const light: ThemeTokens = {
  appBg: '#f2f4f7',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  surfaceActive: '#f0f0f0',
  text: '#212121',
  textMuted: '#727272',
  accent: '#03a9f4',
  accentText: '#ffffff',
  danger: '#db4437',
  border: '#e0e0e0',
  tileRadius: '12px',
  tileGap: '8px',
  tilePadding: '16px',
  fontFamily: "Roboto, 'Helvetica Neue', system-ui, sans-serif",
  shadow: '0 2px 2px rgba(0,0,0,0.14)',
}

export const dark: ThemeTokens = {
  appBg: '#111111',
  surface: '#1c1c1c',
  surfaceRaised: '#282828',
  surfaceActive: '#333333',
  text: '#e1e1e1',
  textMuted: '#9b9b9b',
  accent: '#03a9f4',
  accentText: '#ffffff',
  danger: '#db4437',
  border: '#2e2e2e',
  tileRadius: '12px',
  tileGap: '8px',
  tilePadding: '16px',
  fontFamily: "Roboto, 'Helvetica Neue', system-ui, sans-serif",
  shadow: '0 2px 2px rgba(0,0,0,0.5)',
}
```

- [ ] **Step 5: Write the icon resolver**

Create `src/web/themes/classic/icons.tsx`:

```tsx
import type { ReactElement } from 'react'
import {
  mdiLightbulb, mdiLightbulbOutline, mdiToggleSwitch, mdiToggleSwitchOff,
  mdiFan, mdiGarageOpen, mdiGarage, mdiLock, mdiLockOpenVariant,
} from '@mdi/js'
import type { SupportedDomain } from '@shared/devices.js'

const PATHS: Record<SupportedDomain, (state: string) => string> = {
  light: (s) => (s === 'on' ? mdiLightbulb : mdiLightbulbOutline),
  switch: (s) => (s === 'on' ? mdiToggleSwitch : mdiToggleSwitchOff),
  fan: () => mdiFan,
  input_boolean: (s) => (s === 'on' ? mdiToggleSwitch : mdiToggleSwitchOff),
  cover: (s) => (s === 'open' ? mdiGarageOpen : mdiGarage),
  lock: (s) => (s === 'locked' ? mdiLock : mdiLockOpenVariant),
}

export function icon(domain: SupportedDomain, state: string): ReactElement {
  return (
    <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current" aria-hidden="true">
      <path d={PATHS[domain](state)} />
    </svg>
  )
}
```

- [ ] **Step 6: Write the components**

Home Assistant's tile layout: a circular icon on the left, name and state stacked in the middle, the control on the right. Compact, 12px radius, accent only on the control. Port the copy and ARIA from the default set; use the hooks for behaviour and tokens for every colour.

`Login` and `Disabled` follow the same visual language — a centred card on `--appBg`, `--surface` panel, `--accent` submit button — reusing the existing copy verbatim.

`src/web/themes/classic/index.ts` assembles and default-exports the `Theme`.

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm vitest run test/unit/theme-classic.test.tsx`
Expected: PASS.

- [ ] **Step 8: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
git add src/web/themes/classic package.json pnpm-lock.yaml test/unit/theme-classic.test.tsx
git commit -m "feat: add the classic theme"
```

---

## Task 8: Wire the theme through the app

**Files:**
- Modify: `src/web/App.tsx`, `src/web/routes/Guest.tsx`, `src/web/index.css`, `vite.config.ts`
- Delete: `src/web/components/{ToggleTile,CoverTile,LockTile}.tsx`
- Test: `test/unit/theme-wiring.test.tsx` (create)

**Interfaces:**
- Consumes: `resolveTheme` (Task 5), `DEFAULT_COMPONENTS` (Task 6), `classic` (Task 7).
- Produces: `useTheme(): Theme` reading `document.documentElement.dataset.theme`; `componentsFor(theme)` merging a theme's overrides over the defaults.

- [ ] **Step 1: Write the failing test**

Create `test/unit/theme-wiring.test.tsx`:

```tsx
import { describe, expect, it, beforeEach } from 'vitest'
import { componentsFor, readThemeId } from '../../src/web/themes/active.ts'
import { DEFAULT_COMPONENTS } from '../../src/web/themes/default/index.ts'
import { resolveTheme } from '../../src/web/themes/registry.ts'
import type { Theme } from '../../src/web/themes/types.ts'

describe('active theme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
  })

  it('reads the id the server injected', () => {
    document.documentElement.dataset.theme = 'classic'
    expect(readThemeId()).toBe('classic')
  })

  it('falls back to the default when the attribute is absent', () => {
    expect(readThemeId()).toBe('classic')
  })

  it('a theme with no overrides gets the full default set', () => {
    const bare = { ...resolveTheme('classic'), components: undefined } as Theme
    expect(componentsFor(bare)).toEqual(DEFAULT_COMPONENTS)
  })

  it('a theme overriding one slot keeps defaults for the rest', () => {
    const Custom = () => null
    const partial = { ...resolveTheme('classic'), components: { LockTile: Custom } } as Theme
    const merged = componentsFor(partial)

    expect(merged.LockTile).toBe(Custom)
    expect(merged.ToggleTile).toBe(DEFAULT_COMPONENTS.ToggleTile)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/theme-wiring.test.tsx`
Expected: FAIL — cannot resolve `themes/active.ts`.

- [ ] **Step 3: Write the resolver**

Create `src/web/themes/active.ts`:

```ts
import { DEFAULT_THEME_ID } from '@shared/themes.js'
import { DEFAULT_COMPONENTS } from './default/index.js'
import { resolveTheme } from './registry.js'
import type { Theme } from './types.js'

/**
 * The server writes the active theme onto <html> so the CSS variables apply
 * during parse. Reading it is synchronous — there is no fetch and no flash.
 */
export function readThemeId(): string {
  return document.documentElement.dataset.theme ?? DEFAULT_THEME_ID
}

export function componentsFor(theme: Theme): typeof DEFAULT_COMPONENTS {
  return { ...DEFAULT_COMPONENTS, ...(theme.components ?? {}) }
}

export function activeTheme(): Theme {
  return resolveTheme(readThemeId())
}
```

- [ ] **Step 4: Generate the token CSS from the TypeScript**

The tokens must exist as CSS before any JavaScript loads, but they are declared in TypeScript. Hand-copying them into `index.css` would duplicate every value and drift silently. Generate instead.

Create `scripts/generate-theme-css.ts`:

```ts
// The CSS custom properties must be in a stylesheet — they apply during HTML
// parse, before React loads, which is what makes the portal render themed on
// first paint. But the tokens are declared in TypeScript. Generating the CSS
// keeps one source of truth; `pnpm themes:css --check` fails if they diverge.
import { writeFileSync, readFileSync } from 'node:fs'
import { listThemes } from '../src/web/themes/registry.ts'
import { tokensToCss } from '../src/web/themes/tokens.ts'

const OUT = 'src/web/themes/generated.css'

const css = [
  '/* GENERATED by scripts/generate-theme-css.ts — do not edit by hand. */',
  '/* Regenerate with: pnpm themes:css */',
  '',
  ...listThemes().flatMap((theme) => [
    `[data-theme='${theme.id}'] {`,
    tokensToCss(theme.tokens.light),
    '}',
    '@media (prefers-color-scheme: dark) {',
    `  [data-theme='${theme.id}'] {`,
    tokensToCss(theme.tokens.dark),
    '  }',
    '}',
    '',
  ]),
].join('\n')

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf-8')
  if (current !== css) {
    console.error(`${OUT} is stale. Run: pnpm themes:css`)
    process.exit(1)
  }
  console.log(`${OUT} is up to date`)
} else {
  writeFileSync(OUT, css)
  console.log(`wrote ${OUT}`)
}
```

Add to `package.json`:

```json
    "themes:css": "node --experimental-strip-types scripts/generate-theme-css.ts",
```

Run `pnpm themes:css`, then wire it into `src/web/index.css`:

```css
@import "tailwindcss";
@import "./themes/generated.css";

html, body { background: var(--appBg); font-family: var(--fontFamily); }
```

Add a drift guard to `test/unit/theme-registry.test.ts`:

```ts
  it('the generated CSS is up to date with the TypeScript tokens', () => {
    const { execFileSync } = require('node:child_process')
    // Fails if someone edits a token in TS and forgets to regenerate — the
    // stylesheet is what the browser actually reads.
    expect(() =>
      execFileSync('node', ['--experimental-strip-types', 'scripts/generate-theme-css.ts', '--check']),
    ).not.toThrow()
  })
```

Commit `src/web/themes/generated.css`.

- [ ] **Step 5: Route through the theme**

In `src/web/App.tsx`, replace the direct `Login` / `PortalDisabled` imports with the active theme's components via `componentsFor(activeTheme())`. In `src/web/routes/Guest.tsx`, replace the direct tile imports and the hardcoded shell markup with the theme's `Shell`, `ToggleTile`, `CoverTile` and `LockTile`.

Then delete `src/web/components/{ToggleTile,CoverTile,LockTile}.tsx` — their behaviour now lives in the hooks and their presentation in `themes/default/`.

- [ ] **Step 6: Add dev parity in Vite**

In `vite.config.ts`, add a plugin so `vite dev` injects the same attribute the Node server does:

```ts
    {
      name: 'inject-dev-theme',
      transformIndexHtml(html: string) {
        // Vite serves index.html directly at :5173 without touching the Node
        // server, so dev would otherwise have no data-theme at all.
        const id = process.env.PORTAL_THEME ?? 'classic'
        return html.replace(/<html/i, `<html data-theme="${id}"`)
      },
    },
```

- [ ] **Step 7: Run the whole suite**

Run: `pnpm vitest run`
Expected: PASS. Existing tests importing the deleted tile components must be updated to import from `themes/default/` — update the import path only, not the assertions.

- [ ] **Step 8: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run && pnpm build`

```bash
git add src/web vite.config.ts test
git commit -m "feat: render the guest surface through the active theme"
```

---

## Task 9: Admin picker and the preview pipeline

**Files:**
- Create: `src/web/components/ThemePicker.tsx`, `test/e2e/theme-previews.spec.ts`, `src/web/theme-previews/classic.png`
- Modify: `src/web/routes/Admin.tsx`, `playwright.config.ts`, `package.json`
- Test: `test/unit/theme-picker.test.tsx` (create), `test/unit/theme-previews.test.ts` (create)

**Interfaces:**
- Consumes: `listThemes` (Task 5), `getAdminPortal`/`putAdminTheme` (Task 3).
- Produces: `ThemePicker` rendered above the kill-switch in `Admin.tsx`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/theme-previews.test.ts` — the guard against adding a theme without a preview:

```ts
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { THEME_IDS } from '../../src/shared/themes.ts'

describe('theme previews', () => {
  it('every theme has a preview image', () => {
    for (const id of THEME_IDS) {
      const path = `src/web/theme-previews/${id}.png`
      expect(existsSync(path), `missing ${path} — run: pnpm build && pnpm test:e2e --update-snapshots`).toBe(true)
    }
  })
})
```

Mark it `it.fails` for Phase 1 with the same reasoning as Task 5 — only `classic` has a preview until Phase 3 — and remove the marker in Task 10's final step.

Create `test/unit/theme-picker.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemePicker } from '../../src/web/components/ThemePicker.tsx'
import * as api from '../../src/web/api.ts'

vi.mock('../../src/web/api.ts')

describe('ThemePicker', () => {
  beforeEach(() => {
    vi.mocked(api.getAdminPortal).mockResolvedValue({
      ok: true,
      data: { enabled: true, integrationToken: 'a'.repeat(64), portalId: 'p', theme: 'classic' },
    })
    vi.mocked(api.putAdminTheme).mockResolvedValue({ ok: true, data: undefined })
  })

  it('exposes the options as a radio group', async () => {
    render(<ThemePicker />)
    await waitFor(() => expect(screen.getByRole('radiogroup')).toBeTruthy())
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(0)
  })

  it('marks the stored theme as selected', async () => {
    render(<ThemePicker />)
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /classic/i }).getAttribute('aria-checked')).toBe('true')
    })
  })

  it('saves on selection without a separate confirm', async () => {
    render(<ThemePicker />)
    await waitFor(() => screen.getByRole('radiogroup'))
    await userEvent.click(screen.getByRole('radio', { name: /classic/i }))
    expect(api.putAdminTheme).toHaveBeenCalledWith('classic')
  })

  it('reverts the selection when the save fails', async () => {
    vi.mocked(api.putAdminTheme).mockResolvedValue({ ok: false, status: 500 })
    render(<ThemePicker />)
    await waitFor(() => screen.getByRole('radiogroup'))
    await userEvent.click(screen.getByRole('radio', { name: /classic/i }))
    await waitFor(() => expect(screen.getByTestId('theme-picker-error')).toBeTruthy())
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/unit/theme-picker.test.tsx`
Expected: FAIL — cannot resolve `ThemePicker.tsx`.

- [ ] **Step 3: Write the picker**

`ThemePicker.tsx` loads state with `getAdminPortal()`, renders `listThemes()` as a `role="radiogroup"` of `role="radio"` options — each showing the theme's `name` and its preview image imported from `../theme-previews/<id>.png` — and saves on click with an optimistic update and revert-on-failure, exactly as `PortalToggle` does. Arrow keys move between options. Match `Admin.tsx`'s inline-style convention; the admin surface is not themed.

Handle a failed initial load the way `PortalToggle` does: render the error with a retry button rather than a permanent spinner, and clear the error on a successful reload.

- [ ] **Step 4: Render it in Admin**

In `src/web/routes/Admin.tsx`, render `<ThemePicker />` immediately above `<PortalToggle />`, including in the catalog-error early return — the same reasoning that put the kill-switch there.

- [ ] **Step 5: Write the preview capture spec**

Create `test/e2e/theme-previews.spec.ts`. Configure the snapshot path in `playwright.config.ts` so the baseline **is** the asset the picker imports:

```ts
  snapshotPathTemplate: '{testDir}/../../src/web/theme-previews/{arg}{ext}',
```

```ts
import { test, expect } from '@playwright/test'
import { THEME_IDS } from '../../src/shared/themes.js'
import { startHarness, type TestHarness } from './harness.js'

let harness: TestHarness

test.beforeAll(async () => { harness = await startHarness() })
test.afterAll(async () => { if (harness) await harness.cleanup() })

// The captured image is both the admin picker's preview and the visual
// regression baseline. Changing a theme's appearance fails this test until the
// snapshot is updated, which regenerates the preview — so a stale preview is a
// failing test rather than a matter of discipline.
for (const id of THEME_IDS) {
  test(`preview: ${id}`, async ({ page }) => {
    await page.goto(harness.baseUrl)
    await page.getByLabel('Password').fill('test-admin-password')
    await page.getByRole('button', { name: 'Log in' }).click()

    await page.goto(`${harness.baseUrl}/admin`)
    // seed a fixed device set so the previews differ only by theme
    // ...add three devices via the picker and save...

    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme
    }, id)
    await page.goto(harness.baseUrl)
    await page.setViewportSize({ width: 420, height: 320 })

    await expect(page).toHaveScreenshot(`${id}.png`, { maxDiffPixelRatio: 0.02 })
  })
}
```

- [ ] **Step 6: Write the end-to-end selection test**

The preview spec proves each theme *renders*; nothing yet proves the owner's choice reaches a guest. Append to `test/e2e/portal.spec.ts`:

```ts
test('an admin selects a theme and a guest sees it', async ({ browser }) => {
  const adminContext = await browser.newContext()
  const guestContext = await browser.newContext()
  const adminPage = await adminContext.newPage()
  const guestPage = await guestContext.newPage()

  try {
    await adminPage.goto(`${harness.baseUrl}/admin`)
    await adminPage.getByLabel('Password').fill('test-admin-password')
    await adminPage.getByRole('button', { name: 'Log in' }).click()
    await expect(adminPage.getByRole('radiogroup')).toBeVisible()

    await adminPage.getByRole('radio', { name: /classic/i }).click()

    // The guest's document must carry the chosen theme on first paint —
    // this is the property the whole injection design exists for, and it
    // would fail if the server served a cached or unmutated index.html.
    await guestPage.goto(harness.baseUrl)
    await expect(guestPage.locator('html')).toHaveAttribute('data-theme', 'classic')
  } finally {
    await adminContext.close()
    await guestContext.close()
  }
})
```

Adjust the theme name in the locator once more than one theme exists; in Phase 1 `classic` is the only option.

- [ ] **Step 7: Generate the `classic` preview**

Run: `pnpm build && pnpm test:e2e -g "preview:" --update-snapshots`
Expected: `src/web/theme-previews/classic.png` is created. Commit it.

- [ ] **Step 8: Run everything**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run && pnpm build && pnpm test:e2e`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/web/components/ThemePicker.tsx src/web/routes/Admin.tsx src/web/theme-previews \
        test/e2e/theme-previews.spec.ts test/unit/theme-picker.test.tsx test/unit/theme-previews.test.ts \
        playwright.config.ts
git commit -m "feat: add the admin theme picker and preview pipeline"
```

---

# PHASE 2 — `tiles`

## Task 10: The `tiles` theme

**Files:**
- Create: `src/web/themes/tiles/{index.ts,tokens.ts,icons.tsx,ToggleTile.tsx,CoverTile.tsx,LockTile.tsx,Shell.tsx,Login.tsx,Disabled.tsx}`, `src/web/theme-previews/tiles.png`
- Modify: `src/web/themes/registry.ts`, `src/web/index.css`
- Test: `test/unit/theme-tiles.test.tsx` (create)

**This task is the design's real test.** It should touch only its own folder plus the registry line, the CSS token block and its preview. **If it requires a change to the contract, the hooks, the default set or any other theme, stop and report that — the contract is wrong and should be fixed rather than worked around.**

**Visual specification.** Dark-first. Large rounded squares, `--tileRadius: 20px`, two per row on a phone. The whole tile is the button; tapping anywhere toggles. When on, the tile floods with `--accent` and the icon and text invert to `--accentText`; when off it sits on `--surface`. Icon top-left at 28px, name below in medium weight, state beneath in muted text.

| Token | Light | Dark |
|---|---|---|
| appBg | `#f2f2f7` | `#000000` |
| surface | `#ffffff` | `#1c1c1e` |
| surfaceRaised | `#ffffff` | `#2c2c2e` |
| surfaceActive | `#e5e5ea` | `#3a3a3c` |
| text | `#000000` | `#ffffff` |
| textMuted | `#8e8e93` | `#8e8e93` |
| accent | `#ffb340` | `#ffb340` |
| accentText | `#000000` | `#000000` |
| danger | `#ff3b30` | `#ff453a` |
| border | `#d1d1d6` | `#38383a` |
| tileRadius | `20px` | `20px` |
| tileGap | `12px` | `12px` |
| tilePadding | `16px` | `16px` |
| fontFamily | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif` | same |
| shadow | `0 1px 3px rgba(0,0,0,0.08)` | `none` |

**Icons.** SF Symbols cannot ship in a web application, so this set is a lookalike. Draw six inline SVGs in `icons.tsx` — lightbulb, switch, fan, garage/cover, lock closed, lock open — in SF's idiom: rounded terminals, ~1.8px stroke at 24px, optical weight matched. Do **not** add a dependency for these.

- [ ] **Step 1: Write the failing test**

Create `test/unit/theme-tiles.test.tsx`, mirroring `test/unit/theme-classic.test.tsx` exactly but importing `tiles` and asserting `id === 'tiles'` and `name === 'Tiles'`. Add one case specific to this theme:

```tsx
  it('makes the whole tile the control', () => {
    const ToggleTile = tiles.components!.ToggleTile!
    const { container } = render(
      <ToggleTile
        device={{
          entityId: 'light.porch', label: 'Porch', domain: 'light',
          allowedActions: ['turn_on', 'turn_off'], sortOrder: 0,
          state: { state: 'off', attributes: {}, stale: false },
        }}
        disabled={false}
      />,
    )
    // HomeKit-style: one button covering the tile, not a control inside a card.
    expect(container.querySelectorAll('button')).toHaveLength(1)
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/theme-tiles.test.tsx`
Expected: FAIL — cannot resolve `tiles/index.ts`.

- [ ] **Step 3: Write the theme**

Tokens from the table above; the six inline SVG icons; the six components using the hooks for behaviour and tokens for every value. `Shell` gives a dark app background and a two-column grid. `Login` is a centred card on `--appBg`. `Disabled` keeps the existing copy verbatim.

- [ ] **Step 4: Register it**

Add the import and the map entry in `src/web/themes/registry.ts`, and the `[data-theme='tiles']` token blocks in `src/web/index.css`.

- [ ] **Step 5: Capture the preview**

Run: `pnpm build && pnpm test:e2e -g "preview: tiles" --update-snapshots`

- [ ] **Step 6: Run everything**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run && pnpm build && pnpm test:e2e`
Expected: PASS. `test/unit/theme-registry.test.ts`'s `registry keys match THEME_IDS` is still `it.fails` — `cards` is missing — and should still be failing-as-expected.

- [ ] **Step 7: Commit**

```bash
git add src/web/themes/tiles src/web/themes/registry.ts src/web/index.css \
        src/web/theme-previews/tiles.png test/unit/theme-tiles.test.tsx
git commit -m "feat: add the tiles theme"
```

---

# PHASE 3 — `cards`

## Task 11: The `cards` theme

**Files:**
- Create: `src/web/themes/cards/{index.ts,tokens.ts,icons.tsx,ToggleTile.tsx,CoverTile.tsx,LockTile.tsx,Shell.tsx,Login.tsx,Disabled.tsx}`, `src/web/theme-previews/cards.png`
- Modify: `src/web/themes/registry.ts`, `src/web/index.css`, `package.json`
- Test: `test/unit/theme-cards.test.tsx` (create)

Same constraint as Task 10: **only this folder, the registry line, the CSS block and the preview.** Anything else means the contract is wrong.

**Visual specification.** Light-first, airy. Rounded rectangles, `--tileRadius: 28px`, generous padding. A large circular icon badge is the control — tapping the badge toggles; the card body is inert. The badge fills with `--accent` when on and sits on `--surfaceActive` when off. Name centred beneath the badge in medium weight, state below in muted text.

| Token | Light | Dark |
|---|---|---|
| appBg | `#ffffff` | `#131314` |
| surface | `#f0f4f9` | `#1e1f20` |
| surfaceRaised | `#ffffff` | `#282a2c` |
| surfaceActive | `#e3e8ef` | `#333537` |
| text | `#1f1f1f` | `#e3e3e3` |
| textMuted | `#5f6368` | `#9aa0a6` |
| accent | `#0b57d0` | `#a8c7fa` |
| accentText | `#ffffff` | `#062e6f` |
| danger | `#b3261e` | `#f2b8b5` |
| border | `#dadce0` | `#444746` |
| tileRadius | `28px` | `28px` |
| tileGap | `16px` | `16px` |
| tilePadding | `20px` | `20px` |
| fontFamily | `'Google Sans', Roboto, system-ui, sans-serif` | same |
| shadow | `none` | `none` |

- [ ] **Step 1: Add the icon dependency**

Run: `pnpm add @material-symbols/svg-400@0.47.4`

Import individual SVGs so only the six used are bundled.

- [ ] **Step 2: Write the failing test**

Create `test/unit/theme-cards.test.tsx`, mirroring the `classic` test but for `cards` (`id === 'cards'`, `name === 'Cards'`), plus one case specific to this theme:

```tsx
  it('puts the control on the icon badge, leaving the card body inert', () => {
    const ToggleTile = cards.components!.ToggleTile!
    const { container } = render(
      <ToggleTile
        device={{
          entityId: 'light.porch', label: 'Porch', domain: 'light',
          allowedActions: ['turn_on', 'turn_off'], sortOrder: 0,
          state: { state: 'off', attributes: {}, stale: false },
        }}
        disabled={false}
      />,
    )
    const button = container.querySelector('button')
    expect(button).toBeTruthy()
    // The control is the badge, not the whole card.
    expect(button!.className).not.toMatch(/\bw-full\b/)
  })
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run test/unit/theme-cards.test.tsx`
Expected: FAIL — cannot resolve `cards/index.ts`.

- [ ] **Step 4: Write the theme**

As specified above, using the hooks and tokens.

- [ ] **Step 5: Register it and close out the deferred assertions**

Add the registry entry and the CSS block. Then **remove the `it.fails` markers** from `test/unit/theme-registry.test.ts` (`registry keys match THEME_IDS`) and `test/unit/theme-previews.test.ts` (`every theme has a preview image`) — all three themes now exist, so both must pass on their own merits. If either still fails after removing the marker, that is a real signal: investigate rather than re-adding the marker.

- [ ] **Step 6: Capture the preview**

Run: `pnpm build && pnpm test:e2e -g "preview: cards" --update-snapshots`

- [ ] **Step 7: Run everything**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run && pnpm build && pnpm test:e2e`
Expected: PASS, with zero `it.fails` markers remaining anywhere.

- [ ] **Step 8: Commit**

```bash
git add src/web/themes/cards src/web/themes/registry.ts src/web/index.css \
        src/web/theme-previews/cards.png package.json pnpm-lock.yaml test
git commit -m "feat: add the cards theme"
```

---

## Task 12: Documentation

**Files:**
- Modify: `README.md`, `DOCS.md`, `docs/DECISIONS.md`

- [ ] **Step 1: Document the feature for owners**

`DOCS.md` gains a "Choosing a theme" section: three themes, picked from the admin page, applies to everything a guest sees, takes effect on their next page load. `README.md` gains a short mention in the feature list.

- [ ] **Step 2: Record the decisions**

Append to `docs/DECISIONS.md`, matching its established voice — a bolded claim, the reasoning, then the reversal cost:

- **The theme is injected into the HTML, not fetched.** `<html data-theme>` means the CSS variable block applies during parse, before React loads, so there is no unthemed flash and no endpoint to authenticate. Reversing means accepting a flash or reintroducing a route.
- **Component overrides are optional.** A theme supplying only tokens renders through the default set. This is what keeps a new theme to one folder; it is enforced by a test using a synthetic tokens-only theme, because the three shipped themes all override everything and would not exercise it.
- **The token set is closed.** A theme needing a new token extends the set for everyone. Allowing private tokens would silently break the default set's ability to render an arbitrary theme.
- **Preview images are Playwright snapshot baselines.** A theme's appearance changing fails the test until the snapshot is regenerated, which updates the preview. With no CI in this repository, "auto-captured" would otherwise mean "captured when remembered".
- **Themes are named neutrally.** `tiles`, `cards`, `classic` rather than the products they evoke: the add-on is distributed publicly, and naming a theme after a protected mark while imitating its trade dress is exposure with no engineering benefit.

Also note under accepted risks that `tiles` is a lookalike, because SF Symbols cannot ship in a web application.

- [ ] **Step 3: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run && pnpm build && pnpm test:e2e`

```bash
git add README.md DOCS.md docs/DECISIONS.md
git commit -m "docs: document guest portal themes"
```

---

## Verification Checklist

```bash
pnpm lint
pnpm typecheck
pnpm vitest run
pnpm build && pnpm test:e2e
git status --short          # must be empty
grep -rn "it.fails\|it.skip" test/ || echo "no deferred assertions remain"
```

Manual checks automation cannot cover:

- [ ] Each theme genuinely reads as its inspiration at phone width, not just at desktop.
- [ ] A guest arriving at `/` — not `/admin` — sees the themed login immediately, with no flash of an unstyled page.
- [ ] Switching theme in the admin page and reloading the guest view shows the new theme.
- [ ] Dark mode follows the device for each theme.
