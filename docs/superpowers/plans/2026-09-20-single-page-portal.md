# Single-Page Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guests and owners land on the same themed page; an owner gets Edit and Settings buttons, and the separate admin page is deleted.

**Architecture:** One page for both roles. Role decides only whether `headerActions` is populated. Edit mode and Settings are overlays, not routes. Every edit saves immediately through the existing `putAllowlist`, so the SSE stream stays the single source of truth and there is no dirty state to reconcile against incoming snapshots. A new portal title is injected into the HTML exactly as the theme already is.

**Tech Stack:** TypeScript, React 19, Hono, Zod 4, Tailwind 4 (CSS-first), vitest + happy-dom, Playwright, Biome.

**Spec:** `docs/superpowers/specs/2026-09-20-single-page-portal-design.md`

## Global Constraints

- Biome must report **zero errors and zero warnings**: `pnpm lint`. No non-null assertions (`!`) — Biome warns and this codebase has none.
- `pnpm typecheck` must be clean across all three tsconfigs.
- Baseline before this plan: **781 unit tests passing, 0 expected-fail, 46 files; 8 e2e passing.** No `it.fails` or `it.skip` may be introduced.
- `tsconfig` targets **ES2022**. `Promise.withResolvers` (ES2024) is unavailable; `test/unit/device-hooks.test.tsx` has a local `defer<T>()` helper to copy if needed.
- The owner surfaces (tile editor, entity picker, settings panel) read theme tokens via `var(--token)` but are **not** theme components. Do not add slots to `Theme['components']`.
- Theme `.tsx` files are scanned by tests that fail on Tailwind palette classes, hex literals and `rgb(`/`rgba(`/`hsl(`/`hsla(`. Colours come from `var(--token)`; literals belong only in a theme's `tokens.ts`.
- `pnpm format` must leave the tree unchanged (`biome format` is not part of `pnpm lint`; run it before committing).
- Plain author commits only. **Never** add a `Co-Authored-By` trailer, a "Generated with Claude" footer, a 🤖 line, or any AI-attribution anywhere.
- Do not run `pnpm dev` or `pnpm dev:real`, start Docker containers, or use `sudo`. A dev stack is live on ports 9123/5173. `pnpm build` and `pnpm test:e2e` are allowed where a task says so.
- `test/e2e/screenshots/*.png` are rewritten by every e2e run — restore them (`git checkout --`) or commit them separately.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/shared/portalTitle.ts` | `DEFAULT_PORTAL_TITLE`, `MAX_PORTAL_TITLE_LENGTH`, `normalizePortalTitle()`. Shared because the server validates and injects it and the web reads it back. |
| `src/web/portalTitle.ts` | `readPortalTitle()` — reads the injected attribute, mirroring `readThemeId()`. |
| `src/web/hooks/useAllowlistEditor.ts` | Headless instant-save mutations: add, remove, rename, toggle action, move. Optimistic with revert. |
| `src/web/components/TileEditor.tsx` | Editor for one device: rename, allowed actions, move up/down, remove. Token-styled. |
| `src/web/components/SettingsPanel.tsx` | Theme picker + kill switch + title field. Token-styled. |
| `src/web/components/PortalTitleField.tsx` | The title input, with instant save and revert. |
| `src/web/routes/Portal.tsx` | The one page. Renamed from `Guest.tsx`; adds edit mode and the overlays. |
| `test/unit/portal-title.test.ts` | `normalizePortalTitle` (node project — no DOM). |
| `test/unit/portal-title-dom.test.tsx` | `readPortalTitle` (happy-dom project — needs `document`). |
| `test/unit/shell-contract.test.tsx` | Every registered theme's Shell renders `title` and `headerActions`. |
| `test/unit/allowlist-editor.test.tsx` | The mutation hook. |
| `test/unit/tile-editor.test.tsx` | The per-device editor. |
| `test/unit/settings-panel.test.tsx` | The settings overlay. |
| `test/unit/portal-page.test.tsx` | Role → buttons, edit mode, ghost tile, overlay exclusivity. |

**Modified**

| File | Change |
|---|---|
| `src/shared/api.ts` | `AdminPortalResponse` gains `title`; new `AdminTitlePutRequest`. |
| `src/server/store/settings.ts` | `getTitle()` / `setTitle()`. |
| `src/server/http/routes-admin.ts` | `PUT /api/admin/title`; `title` in `GET /api/admin/portal`. |
| `src/server/app.ts` | Inject `data-portal-title` and `<title>`, escaped. |
| `src/web/api.ts` | `putAdminTitle()`. |
| `src/web/themes/types.ts` | `ShellProps` gains `title` and `headerActions`. |
| `src/web/themes/{default,classic,tiles,cards}/Shell.tsx` | Render `title` and `headerActions`. |
| `src/web/App.tsx` | Drop `/admin` routing; render `Portal` for both roles. |
| `README.md`, `DOCS.md`, `docs/DECISIONS.md`, `scripts/dev-demo.sh` | Remove `/admin`; document the new model. |

**Deleted**

| File | Why |
|---|---|
| `src/web/routes/Admin.tsx` | Replaced by edit mode and the settings panel. |
| `test/unit/admin-screen.test.tsx` | Its 15 tests are migrated into the new component tests, not dropped. |

---

## Task 1: Portal title — shared module and persistence

**Files:**
- Create: `src/shared/portalTitle.ts`, `test/unit/portal-title.test.ts`
- Modify: `src/server/store/settings.ts`
- Test: `test/unit/settings-store.test.ts` (existing — add cases)

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_PORTAL_TITLE: string`, `MAX_PORTAL_TITLE_LENGTH: number`, `normalizePortalTitle(value: string): string`; `SettingsStore.getTitle(): string`, `SettingsStore.setTitle(title: string): void`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/portal-title.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PORTAL_TITLE,
  MAX_PORTAL_TITLE_LENGTH,
  normalizePortalTitle,
} from '../../src/shared/portalTitle.ts'

describe('normalizePortalTitle', () => {
  it('keeps an ordinary title unchanged', () => {
    expect(normalizePortalTitle('Beach House')).toBe('Beach House')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizePortalTitle('  Beach House  ')).toBe('Beach House')
  })

  it('falls back to the default when cleared', () => {
    // Clearing the field should restore the default rather than render an
    // empty header, which would look broken rather than intentional.
    expect(normalizePortalTitle('')).toBe(DEFAULT_PORTAL_TITLE)
    expect(normalizePortalTitle('   ')).toBe(DEFAULT_PORTAL_TITLE)
  })

  it('truncates rather than rejecting an over-long title', () => {
    const long = 'x'.repeat(MAX_PORTAL_TITLE_LENGTH + 20)
    expect(normalizePortalTitle(long)).toHaveLength(MAX_PORTAL_TITLE_LENGTH)
  })

  it('leaves markup alone — escaping is the renderer’s job, not this one’s', () => {
    // Normalising must not silently strip characters; the injection point
    // escapes. Stripping here would hide the need to escape there.
    expect(normalizePortalTitle('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/portal-title.test.ts`
Expected: FAIL — cannot resolve `src/shared/portalTitle.ts`.

- [ ] **Step 3: Write the shared module**

Create `src/shared/portalTitle.ts`:

```ts
/**
 * The name shown in the portal header and the browser tab. Owner-configurable,
 * guest-visible.
 *
 * Normalising and escaping are deliberately separate. This module decides what
 * a title *is*; the HTML injection point decides how to render one safely. If
 * this stripped markup, the injection point would look safe without being safe,
 * and the next person to add a render site would inherit the gap.
 */
export const DEFAULT_PORTAL_TITLE = 'Guest Portal'

/** Long enough for "The Old Rectory Coach House", short enough for a phone header. */
export const MAX_PORTAL_TITLE_LENGTH = 60

export function normalizePortalTitle(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return DEFAULT_PORTAL_TITLE
  return trimmed.slice(0, MAX_PORTAL_TITLE_LENGTH)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run test/unit/portal-title.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the failing store test**

Append to `test/unit/settings-store.test.ts`, inside the existing top-level `describe`:

```ts
  it('returns the default title when nothing is stored', () => {
    const store = new SettingsStore(openDb(':memory:'))
    expect(store.getTitle()).toBe('Guest Portal')
  })

  it('round-trips a stored title', () => {
    const store = new SettingsStore(openDb(':memory:'))
    store.setTitle('Beach House')
    expect(store.getTitle()).toBe('Beach House')
  })

  it('normalises on write, so a blank title cannot be persisted', () => {
    const store = new SettingsStore(openDb(':memory:'))
    store.setTitle('   ')
    expect(store.getTitle()).toBe('Guest Portal')
  })
```

If the existing file constructs its store differently, match its convention rather than the lines above; the assertions are what matter.

- [ ] **Step 6: Implement the store methods**

In `src/server/store/settings.ts`, add the key beside the others:

```ts
const KEY_PORTAL_TITLE = 'portal_title'
```

and the accessors beside `getTheme`/`setTheme`:

```ts
  getTitle(): string {
    const stored = this.read(KEY_PORTAL_TITLE)
    return stored === null ? DEFAULT_PORTAL_TITLE : normalizePortalTitle(stored)
  }

  setTitle(title: string): void {
    this.write(KEY_PORTAL_TITLE, normalizePortalTitle(title))
  }
```

Import at the top: `import { DEFAULT_PORTAL_TITLE, normalizePortalTitle } from '@shared/portalTitle.js'`.

Normalising on read as well as write is deliberate: a row written by an older build, or edited in the database by hand, still yields something renderable.

- [ ] **Step 7: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add src/shared/portalTitle.ts src/server/store/settings.ts test/unit/portal-title.test.ts test/unit/settings-store.test.ts
git commit -m "feat: persist a configurable portal title"
```

---

## Task 2: Portal title — admin API

**Files:**
- Modify: `src/shared/api.ts`, `src/server/http/routes-admin.ts`, `src/web/api.ts`
- Test: `test/integration/routes-admin.test.ts` (existing — add cases)

**Interfaces:**
- Consumes: `DEFAULT_PORTAL_TITLE`, `MAX_PORTAL_TITLE_LENGTH`, `normalizePortalTitle` (Task 1); `SettingsStore.getTitle/setTitle` (Task 1).
- Produces: `AdminTitlePutRequest` (Zod); `GET /api/admin/portal` response gains `title: string`; `PUT /api/admin/title`; client `putAdminTitle(title: string): Promise<ApiResult<void>>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/integration/routes-admin.test.ts`, matching how neighbouring tests obtain `adminCookie` and `baseUrl`:

```ts
  it('GET /api/admin/portal includes the current title', async () => {
    const res = await fetch(`${baseUrl}/api/admin/portal`, {
      headers: { Cookie: adminCookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { title: string }
    expect(body.title).toBe('Guest Portal')
  })

  it('PUT /api/admin/title stores a new title', async () => {
    const res = await fetch(`${baseUrl}/api/admin/title`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ title: 'Beach House' }),
    })
    expect(res.status).toBe(200)
    expect(settings.getTitle()).toBe('Beach House')
  })

  it('PUT /api/admin/title rejects an over-long title and leaves the stored one alone', async () => {
    settings.setTitle('Beach House')
    const res = await fetch(`${baseUrl}/api/admin/title`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ title: 'x'.repeat(200) }),
    })
    expect(res.status).toBe(400)
    // The point of the test: a rejected write must not have taken effect.
    expect(settings.getTitle()).toBe('Beach House')
  })

  it('PUT /api/admin/title rejects malformed JSON', async () => {
    const res = await fetch(`${baseUrl}/api/admin/title`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: '{ not json',
    })
    expect(res.status).toBe(400)
  })

  it('PUT /api/admin/title requires an admin session', async () => {
    const anon = await fetch(`${baseUrl}/api/admin/title`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Beach House' }),
    })
    expect(anon.status).toBe(401)

    const asGuest = await fetch(`${baseUrl}/api/admin/title`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: guestCookie },
      body: JSON.stringify({ title: 'Beach House' }),
    })
    expect(asGuest.status).toBe(403)
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/integration/routes-admin.test.ts`
Expected: FAIL — 404 on the new route, and `title` missing from the portal response.

- [ ] **Step 3: Extend the shared schemas**

In `src/shared/api.ts`, add `title` to `AdminPortalResponse`:

```ts
export const AdminPortalResponse = z.object({
  enabled: z.boolean(),
  integrationToken: z.string(),
  portalId: z.string(),
  theme: z.enum(THEME_IDS),
  title: z.string(),
})
```

and add the request schema beside `AdminThemePutRequest`:

```ts
export const AdminTitlePutRequest = z.object({
  title: z
    .string()
    .max(MAX_PORTAL_TITLE_LENGTH, `Title must be ${MAX_PORTAL_TITLE_LENGTH} characters or fewer`),
})
```

Import `MAX_PORTAL_TITLE_LENGTH` from `./portalTitle.js`.

- [ ] **Step 4: Add the route**

In `src/server/http/routes-admin.ts`, add `title: settings.getTitle()` to the `GET /api/admin/portal` response object, and add the handler immediately after the theme one, mirroring it exactly:

```ts
  // PUT /api/admin/title - rename the portal as guests see it
  app.put('/api/admin/title', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = AdminTitlePutRequest.safeParse(body)
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0]
      return c.json({ error: firstIssue ? firstIssue.message : 'Invalid request' }, 400)
    }

    settings.setTitle(parseResult.data.title)

    return c.json({ title: settings.getTitle() })
  })
```

Returning `settings.getTitle()` rather than the submitted string means the client sees the normalised value — so clearing the field visibly snaps back to the default instead of appearing to save a blank.

- [ ] **Step 5: Add the client function**

In `src/web/api.ts`, beside `putAdminTheme`:

```ts
export async function putAdminTitle(title: string): Promise<ApiResult<void>> {
  const response = await fetch('/api/admin/title', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
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

- [ ] **Step 6: Run to verify they pass**

Run: `pnpm vitest run test/integration/routes-admin.test.ts`
Expected: PASS.

Note any existing test that asserts the exact shape of the portal response will now need `title` — extend those assertions, do not loosen them.

- [ ] **Step 7: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add src/shared/api.ts src/server/http/routes-admin.ts src/web/api.ts test/integration/routes-admin.test.ts
git commit -m "feat: add the portal title admin route"
```

---

## Task 3: Portal title — HTML injection, escaped

**Files:**
- Modify: `src/server/app.ts`
- Create: `src/web/portalTitle.ts`, `test/unit/portal-title-dom.test.tsx`
- Test: `test/integration/routes-guest.test.ts` (existing — add cases)

**Interfaces:**
- Consumes: `SettingsStore.getTitle()` (Task 1), `DEFAULT_PORTAL_TITLE` (Task 1).
- Produces: `<html data-portal-title="…">` and `<title>…</title>` on every injected document; `readPortalTitle(): string`.

- [ ] **Step 1: Write the failing server tests**

Append to `test/integration/routes-guest.test.ts`, in the `HTML injection` describe (it already has a `writeStubIndex()` helper and the `INDEX` constant):

```ts
    it('injects the portal title into the attribute and the tab title', async () => {
      await writeStubIndex()
      settings.setTitle('Beach House')

      const res = await fetch(`${baseUrl}/`)
      const html = await res.text()

      expect(html).toContain('data-portal-title="Beach House"')
      expect(html).toContain('<title>Beach House</title>')
    })

    it('escapes a hostile title rather than emitting it raw', async () => {
      await writeStubIndex()
      // The title is owner-supplied text written into HTML. This is the only
      // new injection surface in the single-page change.
      settings.setTitle('"><script>alert(1)</script>')

      const res = await fetch(`${baseUrl}/`)
      const html = await res.text()

      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;')
      expect(html).not.toContain('data-portal-title=""><')
    })
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run test/integration/routes-guest.test.ts`
Expected: FAIL — no `data-portal-title` in the output.

- [ ] **Step 3: Implement the injection**

In `src/server/app.ts`, add above `renderIndexHtml`:

```ts
/**
 * The portal title is owner-supplied text going into two HTML contexts — a
 * double-quoted attribute and element text. Escaping these five characters
 * covers both. `&` must be replaced first, or the escapes introduced by the
 * later replacements would themselves be re-escaped.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
```

and extend the return of `renderIndexHtml`:

```ts
  const title = escapeHtml(deps.settings.getTitle())

  return html
    .replace(/(<head[^>]*>)/i, `$1\n    <base href="${normalizedBase}">`)
    .replace(/<html/i, `<html data-theme="${deps.settings.getTheme()}" data-portal-title="${title}"`)
    .replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`)
```

If the built `index.html` has no `<title>` element the third replace is a no-op, which is acceptable: the attribute is what the header reads.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run test/integration/routes-guest.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the client reader with its test**

Create `test/unit/portal-title-dom.test.tsx` — a **separate file** from Task 1's. `test/unit/**/*.test.ts` runs under the `node` project where `document` does not exist; only `.test.tsx` runs under happy-dom. Do not move Task 1's cases; they need no DOM.

```tsx
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PORTAL_TITLE } from '../../src/shared/portalTitle.ts'
import { readPortalTitle } from '../../src/web/portalTitle.ts'

describe('readPortalTitle', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-portal-title')
  })

  it('reads the title the server injected', () => {
    document.documentElement.dataset.portalTitle = 'Beach House'
    expect(readPortalTitle()).toBe('Beach House')
  })

  it('falls back to the default when the attribute is absent', () => {
    expect(readPortalTitle()).toBe(DEFAULT_PORTAL_TITLE)
  })

  it('falls back when the attribute is present but blank', () => {
    document.documentElement.dataset.portalTitle = '   '
    expect(readPortalTitle()).toBe(DEFAULT_PORTAL_TITLE)
  })
})
```

Create `src/web/portalTitle.ts`:

```ts
import { DEFAULT_PORTAL_TITLE } from '@shared/portalTitle.js'

/**
 * The server writes the title onto <html> in the same pass that writes the
 * theme, so the header is correct on first paint with no fetch. Guests need the
 * title and have no admin endpoints; injecting it avoids adding a public
 * settings route to serve one string.
 */
export function readPortalTitle(): string {
  const raw = document.documentElement.dataset.portalTitle
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORTAL_TITLE
  return raw
}
```

- [ ] **Step 6: Run to verify**

Run: `pnpm vitest run test/unit/portal-title.test.ts test/unit/portal-title-dom.test.tsx`
Expected: PASS — 5 tests in the first file, 3 in the second.

- [ ] **Step 7: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add src/server/app.ts src/web/portalTitle.ts test/unit/portal-title-dom.test.tsx test/integration/routes-guest.test.ts
git commit -m "feat: inject the portal title into the document, escaped"
```

---

## Task 4: Shell contract — title and headerActions

**Files:**
- Modify: `src/web/themes/types.ts`, `src/web/themes/{default,classic,tiles,cards}/Shell.tsx`
- Create: `test/unit/shell-contract.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `ShellProps` with `title: string` and `headerActions?: ReactElement`; all four Shells render both.

**Why a contract test.** A future theme that quietly drops `headerActions` locks an owner out of their own settings while the portal still looks perfectly fine. That failure is invisible in every other test, so it gets its own.

- [ ] **Step 1: Write the failing test**

Create `test/unit/shell-contract.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach } from 'vitest'
import { DEFAULT_COMPONENTS } from '../../src/web/themes/default/index.ts'
import { listThemes } from '../../src/web/themes/registry.ts'
import { componentsFor } from '../../src/web/themes/active.ts'

afterEach(() => {
  cleanup()
})

// Every theme's Shell, plus the default set, which a tokens-only theme uses.
const shells: { id: string; Shell: typeof DEFAULT_COMPONENTS.Shell }[] = [
  { id: 'default', Shell: DEFAULT_COMPONENTS.Shell },
  ...listThemes().map((theme) => ({ id: theme.id, Shell: componentsFor(theme).Shell })),
]

describe('Shell contract', () => {
  it('covers every registered theme', () => {
    // Guards the loops below: an empty list would satisfy them vacuously.
    expect(shells.length).toBeGreaterThan(1)
  })

  for (const { id, Shell } of shells) {
    it(`${id}: renders the title it is given, not a hardcoded one`, () => {
      render(
        <Shell title="Beach House" onLogout={() => {}} loggingOut={false}>
          <div />
        </Shell>,
      )
      expect(screen.getByText('Beach House')).toBeTruthy()
      expect(screen.queryByText('Guest Portal')).toBeNull()
    })

    it(`${id}: renders headerActions when given them`, () => {
      render(
        <Shell
          title="Beach House"
          onLogout={() => {}}
          loggingOut={false}
          headerActions={<button type="button">Settings</button>}
        >
          <div />
        </Shell>,
      )
      // An owner who cannot reach this button cannot reach their settings.
      expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    })

    it(`${id}: renders nothing extra when headerActions is omitted`, () => {
      render(
        <Shell title="Beach House" onLogout={() => {}} loggingOut={false}>
          <div />
        </Shell>,
      )
      // A guest must not see an empty slot or a stray container.
      expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
    })
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/shell-contract.test.tsx`
Expected: FAIL — `title` is not a prop and every Shell hardcodes `Guest Portal`.

- [ ] **Step 3: Extend the contract**

In `src/web/themes/types.ts`:

```ts
export type ShellProps = {
  children: ReactElement | ReactElement[]
  onLogout: () => void
  loggingOut: boolean
  /** The owner-configured portal name. Never hardcode a title in a Shell. */
  title: string
  /**
   * Owner-only controls (Edit, Settings), or undefined for a guest. A Shell
   * MUST render this when present — dropping it locks an owner out of their
   * own settings with no other visible symptom. `test/unit/shell-contract.test.tsx`
   * enforces it for every registered theme.
   */
  headerActions?: ReactElement
}
```

- [ ] **Step 4: Update all four Shells**

In each of `src/web/themes/{default,classic,tiles,cards}/Shell.tsx`: destructure `title` and `headerActions`, replace the hardcoded `Guest Portal` string with `{title}`, and render `headerActions` in the header beside the logout button. For `classic`:

```tsx
export function Shell({
  children,
  onLogout,
  loggingOut,
  title,
  headerActions,
}: ShellProps): ReactElement {
  return (
    <div
      data-testid="guest-screen"
      className="min-h-screen bg-[var(--appBg)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <header className="flex justify-between items-center px-[var(--tilePadding)] py-3 bg-[var(--surfaceRaised)] shadow-[var(--shadow)]">
        <h1 className="text-xl font-medium text-[var(--text)]">{title}</h1>
        <div className="flex items-center gap-2">
          {headerActions}
          <button
            type="button"
            onClick={onLogout}
            disabled={loggingOut}
            className="px-4 py-2 text-sm font-medium rounded-[var(--tileRadius)] text-[var(--text)] bg-[var(--surfaceActive)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loggingOut ? 'Logging out...' : 'Log out'}
          </button>
        </div>
      </header>

      <div className="p-[var(--tilePadding)]">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-[var(--tileGap)] max-w-7xl">
          {children}
        </div>
      </div>
    </div>
  )
}
```

Apply the same three changes to the other three, keeping each theme's own markup and classes. Do not introduce a wrapper element when `headerActions` is undefined — `{headerActions}` renders nothing, which is what the third test checks.

- [ ] **Step 5: Fix the callers so the suite compiles**

`src/web/routes/Guest.tsx` now fails typecheck because `title` is required. Pass it through for now:

```tsx
import { readPortalTitle } from '../portalTitle.js'
// ...
    <Shell title={readPortalTitle()} loggingOut={loggingOut} onLogout={...}>
```

Task 8 replaces this file wholesale; this keeps the tree green in between.

- [ ] **Step 6: Run everything**

Run: `pnpm vitest run`
Expected: PASS. Existing theme tests that render a Shell will need the `title` prop added — that is a compile fix, not an assertion change. Any test asserting the literal text `Guest Portal` in a header should pass `title="Guest Portal"` explicitly rather than be deleted.

- [ ] **Step 7: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add src/web/themes test/unit/shell-contract.test.tsx src/web/routes/Guest.tsx
git commit -m "feat: give Shell a title and an owner-actions slot"
```

---

## Task 5: The allowlist editor hook

**Files:**
- Create: `src/web/hooks/useAllowlistEditor.ts`, `test/unit/allowlist-editor.test.tsx`
- Reference: `test/unit/admin-screen.test.tsx` — the mutation behaviour being migrated

**Interfaces:**
- Consumes: `putAllowlist` from `src/web/api.js`; `Device`, `AllowlistRow`, `CatalogEntry` from `@shared/api.js`; `DOMAIN_ACTIONS`, `parseDomain` from `@shared/devices.js`.
- Produces:

```ts
export type AllowlistEditor = {
  rows: AllowlistRow[]
  pending: boolean
  error: string | null
  add: (entity: CatalogEntry) => void
  remove: (entityId: string) => void
  rename: (entityId: string, label: string) => void
  toggleAction: (entityId: string, action: string) => void
  move: (entityId: string, direction: -1 | 1) => void
  dismissError: () => void
}
export function useAllowlistEditor(devices: Device[]): AllowlistEditor
```

**Design notes the implementer needs.**

- Rows are **derived from the live device list**, not fetched. `Device` is a superset of `AllowlistRow`, so the SSE stream is the single source of truth and there is no second copy to reconcile. Keep an optimistic overlay only while a write is in flight.
- Mutations are keyed by `entityId`, never by array index. The list can change underneath from another session's edit arriving over SSE; an index would then mutate the wrong device.
- A device added from the picker gets `allowedActions: []`. Every theme already renders that as a `No actions available` tile, so it is visible but cannot be actuated until the owner chooses actions.

- [ ] **Step 1: Write the failing test**

Create `test/unit/allowlist-editor.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { CatalogEntry, Device } from '@shared/api.js'
import { useAllowlistEditor } from '../../src/web/hooks/useAllowlistEditor.ts'
import * as api from '../../src/web/api.ts'

function device(overrides: Partial<Device> = {}): Device {
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

const two = [
  device(),
  device({ entityId: 'lock.front', label: 'Front', domain: 'lock', allowedActions: ['unlock'], sortOrder: 1 }),
]

describe('useAllowlistEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(api, 'putAllowlist').mockResolvedValue({ ok: true, data: undefined })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('derives rows from the live devices, sorted', () => {
    const { result } = renderHook(() =>
      useAllowlistEditor([two[1] as Device, two[0] as Device]),
    )
    expect(result.current.rows.map((r) => r.entityId)).toEqual(['light.porch', 'lock.front'])
  })

  it('renames by entity id, not by position', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two))
    act(() => {
      result.current.rename('lock.front', 'Front Door')
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putAllowlist).mock.calls[0]?.[0]
    expect(sent?.find((r) => r.entityId === 'lock.front')?.label).toBe('Front Door')
    expect(sent?.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch')
  })

  it('adds a device with no allowed actions so it cannot be operated yet', async () => {
    const entry = { entityId: 'switch.fan', name: 'Fan', supported: true } as CatalogEntry
    const { result } = renderHook(() => useAllowlistEditor(two))
    act(() => {
      result.current.add(entry)
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putAllowlist).mock.calls[0]?.[0]
    const added = sent?.find((r) => r.entityId === 'switch.fan')
    expect(added?.allowedActions).toEqual([])
    expect(added?.sortOrder).toBe(2)
  })

  it('toggles an action off and on again', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two))
    act(() => {
      result.current.toggleAction('light.porch', 'turn_off')
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putAllowlist).mock.calls[0]?.[0]
    expect(sent?.find((r) => r.entityId === 'light.porch')?.allowedActions).toEqual(['turn_on'])
  })

  it('removes by entity id', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two))
    act(() => {
      result.current.remove('light.porch')
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putAllowlist).mock.calls[0]?.[0]
    expect(sent?.map((r) => r.entityId)).toEqual(['lock.front'])
  })

  it('reindexes sortOrder after a move so the order is contiguous', async () => {
    const { result } = renderHook(() => useAllowlistEditor(two))
    act(() => {
      result.current.move('lock.front', -1)
    })
    await waitFor(() => expect(api.putAllowlist).toHaveBeenCalled())
    const sent = vi.mocked(api.putAllowlist).mock.calls[0]?.[0]
    expect(sent?.map((r) => [r.entityId, r.sortOrder])).toEqual([
      ['lock.front', 0],
      ['light.porch', 1],
    ])
  })

  it('ignores a move that would fall off either end', () => {
    const { result } = renderHook(() => useAllowlistEditor(two))
    act(() => {
      result.current.move('light.porch', -1)
    })
    expect(api.putAllowlist).not.toHaveBeenCalled()
  })

  it('shows the change immediately, before the server answers', async () => {
    const deferred: { resolve: (v: { ok: true; data: undefined }) => void } = { resolve: () => {} }
    vi.spyOn(api, 'putAllowlist').mockReturnValue(
      new Promise((r) => {
        deferred.resolve = r as typeof deferred.resolve
      }),
    )
    const { result } = renderHook(() => useAllowlistEditor(two))

    act(() => {
      result.current.rename('light.porch', 'Porch Light')
    })
    expect(result.current.rows.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch Light')
    expect(result.current.pending).toBe(true)

    await act(async () => {
      deferred.resolve({ ok: true, data: undefined })
    })
    expect(result.current.pending).toBe(false)
  })

  it('reverts and reports when the save fails', async () => {
    vi.spyOn(api, 'putAllowlist').mockResolvedValue({ ok: false, status: 500 })
    const { result } = renderHook(() => useAllowlistEditor(two))

    act(() => {
      result.current.rename('light.porch', 'Porch Light')
    })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    // The grid must go back to the truth, not keep showing a change that
    // never landed.
    expect(result.current.rows.find((r) => r.entityId === 'light.porch')?.label).toBe('Porch')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/allowlist-editor.test.tsx`
Expected: FAIL — cannot resolve `useAllowlistEditor.ts`.

- [ ] **Step 3: Write the hook**

Create `src/web/hooks/useAllowlistEditor.ts`:

```ts
import { useCallback, useState } from 'react'
import type { AllowlistRow, CatalogEntry, Device } from '@shared/api.js'
import { putAllowlist } from '../api.js'

export type AllowlistEditor = {
  rows: AllowlistRow[]
  pending: boolean
  error: string | null
  add: (entity: CatalogEntry) => void
  remove: (entityId: string) => void
  rename: (entityId: string, label: string) => void
  toggleAction: (entityId: string, action: string) => void
  move: (entityId: string, direction: -1 | 1) => void
  dismissError: () => void
}

/** `Device` is a superset of `AllowlistRow`; the stream is the source of truth. */
function toRows(devices: Device[]): AllowlistRow[] {
  return [...devices]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(({ entityId, label, allowedActions, sortOrder }) => ({
      entityId,
      label,
      allowedActions,
      sortOrder,
    }))
}

function reindex(rows: AllowlistRow[]): AllowlistRow[] {
  return rows.map((row, i) => ({ ...row, sortOrder: i }))
}

/**
 * Instant-save editing of the allowlist.
 *
 * There is no dirty state by design. This page also holds a live SSE stream, so
 * batching edits locally would mean reconciling every incoming snapshot against
 * uncommitted changes. Writing immediately keeps the stream authoritative: the
 * optimistic overlay exists only for the moment a request is in flight, and is
 * dropped as soon as the server answers either way.
 *
 * Mutations are keyed by entity id, never by index — another session's edit can
 * reorder the list underneath, and an index would then hit the wrong device.
 */
export function useAllowlistEditor(devices: Device[]): AllowlistEditor {
  const [optimistic, setOptimistic] = useState<AllowlistRow[] | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rows = optimistic ?? toRows(devices)

  const commit = useCallback(async (next: AllowlistRow[]): Promise<void> => {
    setOptimistic(next)
    setPending(true)
    setError(null)

    try {
      const result = await putAllowlist(next)
      if (!result.ok) {
        setError('Could not save that change')
      }
    } finally {
      // Either way the overlay goes: on success the stream delivers the same
      // list, on failure the stream still holds the truth we reverted to.
      setOptimistic(null)
      setPending(false)
    }
  }, [])

  const mutate = useCallback(
    (fn: (current: AllowlistRow[]) => AllowlistRow[] | null): void => {
      const next = fn(optimistic ?? toRows(devices))
      if (next === null) return
      void commit(next)
    },
    [commit, devices, optimistic],
  )

  return {
    rows,
    pending,
    error,
    dismissError: () => {
      setError(null)
    },
    add: (entity) =>
      mutate((current) =>
        reindex([
          ...current,
          { entityId: entity.entityId, label: entity.name, allowedActions: [], sortOrder: 0 },
        ]),
      ),
    remove: (entityId) => mutate((current) => reindex(current.filter((r) => r.entityId !== entityId))),
    rename: (entityId, label) =>
      mutate((current) => current.map((r) => (r.entityId === entityId ? { ...r, label } : r))),
    toggleAction: (entityId, action) =>
      mutate((current) =>
        current.map((r) =>
          r.entityId === entityId
            ? {
                ...r,
                allowedActions: r.allowedActions.includes(action)
                  ? r.allowedActions.filter((a) => a !== action)
                  : [...r.allowedActions, action],
              }
            : r,
        ),
      ),
    move: (entityId, direction) =>
      mutate((current) => {
        const from = current.findIndex((r) => r.entityId === entityId)
        const to = from + direction
        if (from === -1 || to < 0 || to >= current.length) return null
        const next = [...current]
        const [moved] = next.splice(from, 1)
        if (moved === undefined) return null
        next.splice(to, 0, moved)
        return reindex(next)
      }),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run test/unit/allowlist-editor.test.tsx`
Expected: PASS, 9 tests.

- [ ] **Step 5: Prove the tests discriminate**

Run each mutant, confirm the stated test fails, then revert:

1. `add` supplies the entity's default actions instead of `[]` → "adds a device with no allowed actions" fails.
2. `rename` matches by index instead of entity id → "renames by entity id, not by position" fails.
3. `commit` does not clear `optimistic` on failure → "reverts and reports when the save fails" fails.
4. `move` omits `reindex` → "reindexes sortOrder" fails.

Report the outcome of all four.

- [ ] **Step 6: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add src/web/hooks/useAllowlistEditor.ts test/unit/allowlist-editor.test.tsx
git commit -m "feat: add the instant-save allowlist editor hook"
```

---

## Task 6: The tile editor

**Files:**
- Create: `src/web/components/TileEditor.tsx`, `test/unit/tile-editor.test.tsx`
- Reference: `src/web/routes/Admin.tsx` — the per-device controls being migrated

**Interfaces:**
- Consumes: `AllowlistEditor` (Task 5); `DOMAIN_ACTIONS`, `parseDomain` from `@shared/devices.js`.
- Produces:

```tsx
export type TileEditorProps = {
  row: AllowlistRow
  editor: AllowlistEditor
  onClose: () => void
}
export function TileEditor(props: TileEditorProps): ReactElement
```

**Migration duty.** `test/unit/admin-screen.test.tsx` contains 15 tests, several covering renaming, action toggling, reordering and removal. Those behaviours move here. Port the relevant assertions into this task's test file **unchanged in meaning** — if one fails, this component is wrong. Do not delete a behaviour because its old host is going away.

**Styling.** Token-based (`var(--surface)`, `var(--text)`, `var(--accent)`, `var(--danger)`, `var(--tileRadius)`, `var(--fontFamily)`). No Tailwind palette classes, no hex. It is not a theme component and takes no new Theme slot.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tile-editor.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AllowlistRow } from '@shared/api.js'
import { TileEditor } from '../../src/web/components/TileEditor.tsx'
import type { AllowlistEditor } from '../../src/web/hooks/useAllowlistEditor.ts'

function editorStub(overrides: Partial<AllowlistEditor> = {}): AllowlistEditor {
  return {
    rows: [],
    pending: false,
    error: null,
    add: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    toggleAction: vi.fn(),
    move: vi.fn(),
    dismissError: vi.fn(),
    ...overrides,
  }
}

const lightRow: AllowlistRow = {
  entityId: 'light.porch',
  label: 'Porch',
  allowedActions: ['turn_on'],
  sortOrder: 0,
}

afterEach(() => {
  cleanup()
})

describe('TileEditor', () => {
  it('renames on input', async () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    const field = screen.getByLabelText(/name/i)
    await userEvent.clear(field)
    await userEvent.type(field, 'Porch Light')

    expect(editor.rename).toHaveBeenLastCalledWith('light.porch', 'Porch Light')
  })

  it('offers every action the domain supports, checked to match the row', () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    const on = screen.getByRole('checkbox', { name: /turn_on/i }) as HTMLInputElement
    const off = screen.getByRole('checkbox', { name: /turn_off/i }) as HTMLInputElement
    expect(on.checked).toBe(true)
    expect(off.checked).toBe(false)
  })

  it('toggles an action', async () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    await userEvent.click(screen.getByRole('checkbox', { name: /turn_off/i }))

    expect(editor.toggleAction).toHaveBeenCalledWith('light.porch', 'turn_off')
  })

  it('moves up and down', async () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: /move up/i }))
    expect(editor.move).toHaveBeenCalledWith('light.porch', -1)

    await userEvent.click(screen.getByRole('button', { name: /move down/i }))
    expect(editor.move).toHaveBeenCalledWith('light.porch', 1)
  })

  it('confirms before removing, and does not remove if declined', async () => {
    const editor = editorStub()
    render(<TileEditor row={lightRow} editor={editor} onClose={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }))
    // Removal is the one destructive edit and there is no save step to undo it.
    expect(editor.remove).not.toHaveBeenCalled()
    expect(screen.getByText(/remove porch\?/i)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(editor.remove).not.toHaveBeenCalled()
  })

  it('removes once confirmed, and closes', async () => {
    const editor = editorStub()
    const onClose = vi.fn()
    render(<TileEditor row={lightRow} editor={editor} onClose={onClose} />)

    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }))
    await userEvent.click(screen.getByRole('button', { name: /yes, remove/i }))

    expect(editor.remove).toHaveBeenCalledWith('light.porch')
    expect(onClose).toHaveBeenCalled()
  })

  it('surfaces a failed save', () => {
    render(
      <TileEditor
        row={lightRow}
        editor={editorStub({ error: 'Could not save that change' })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/could not save that change/i)).toBeTruthy()
  })

  it('uses no hardcoded colours — every colour comes from a token', () => {
    const src = readFileSync('src/web/components/TileEditor.tsx', 'utf-8')
    expect(src).not.toMatch(
      /\b(bg|text|border)-(gray|blue|red|green|yellow|indigo|purple|pink|slate|zinc)-\d{2,3}\b/,
    )
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(src).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/)
  })
})
```

Add `import { readFileSync } from 'node:fs'` at the top.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/tile-editor.test.tsx`
Expected: FAIL — cannot resolve `TileEditor.tsx`.

- [ ] **Step 3: Write the component**

Create `src/web/components/TileEditor.tsx`. Requirements, not a transcription — write it in the codebase's idiom:

- a labelled text input for the name, calling `editor.rename(row.entityId, value)` on change
- one checkbox per action from `DOMAIN_ACTIONS[parseDomain(row.entityId)]`, checked when `row.allowedActions` includes it, calling `editor.toggleAction`
- **Move up** and **Move down** buttons calling `editor.move(row.entityId, -1 | 1)`
- a **Remove** button that reveals an inline confirmation (`Remove <label>?` with **Yes, remove** and **Cancel**); confirming calls `editor.remove` then `onClose`
- `editor.error` rendered when present
- a close affordance calling `onClose`
- every colour from `var(--token)`; the panel sits on `var(--surface)` with `var(--tileRadius)` corners

If `parseDomain` returns `null` (an entity whose domain is unsupported), render the name field and Remove only — there are no actions to offer. Do not crash.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run test/unit/tile-editor.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add src/web/components/TileEditor.tsx test/unit/tile-editor.test.tsx
git commit -m "feat: add the per-device tile editor"
```

---

## Task 7: The settings panel

**Files:**
- Create: `src/web/components/SettingsPanel.tsx`, `src/web/components/PortalTitleField.tsx`, `test/unit/settings-panel.test.tsx`
- Reference: `src/web/components/{ThemePicker,PortalToggle}.tsx` — reused as-is

**Interfaces:**
- Consumes: `ThemePicker`, `PortalToggle` (existing, unchanged); `putAdminTitle`, `getAdminPortal` (Task 2); `readPortalTitle` (Task 3).
- Produces:

```tsx
export function SettingsPanel({ onClose }: { onClose: () => void }): ReactElement
export function PortalTitleField(): ReactElement
```

- [ ] **Step 1: Write the failing test**

Create `test/unit/settings-panel.test.tsx`:

```tsx
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsPanel } from '../../src/web/components/SettingsPanel.tsx'
import * as api from '../../src/web/api.ts'

vi.mock('../../src/web/api.ts')

describe('SettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getAdminPortal).mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
        theme: 'classic',
        title: 'Guest Portal',
      },
    })
    vi.mocked(api.putAdminTitle).mockResolvedValue({ ok: true, data: undefined })
    vi.mocked(api.putAdminTheme).mockResolvedValue({ ok: true, data: undefined })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('holds the theme picker, the kill switch and the title field', async () => {
    render(<SettingsPanel onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('radiogroup')).toBeTruthy())
    expect(screen.getByLabelText(/portal name/i)).toBeTruthy()
    expect(screen.getByRole('switch')).toBeTruthy()
  })

  it('saves a new title', async () => {
    render(<SettingsPanel onClose={() => {}} />)
    const field = await screen.findByLabelText(/portal name/i)

    await userEvent.clear(field)
    await userEvent.type(field, 'Beach House')
    await userEvent.tab()

    await waitFor(() => expect(api.putAdminTitle).toHaveBeenCalledWith('Beach House'))
  })

  it('does not save the title on every keystroke', async () => {
    render(<SettingsPanel onClose={() => {}} />)
    const field = await screen.findByLabelText(/portal name/i)

    await userEvent.clear(field)
    await userEvent.type(field, 'Beach')

    // A PUT per character would hammer the server and race itself.
    expect(api.putAdminTitle).not.toHaveBeenCalled()
  })

  it('reverts the field and reports when the save fails', async () => {
    vi.mocked(api.putAdminTitle).mockResolvedValue({ ok: false, status: 500 })
    render(<SettingsPanel onClose={() => {}} />)
    const field = (await screen.findByLabelText(/portal name/i)) as HTMLInputElement

    await userEvent.clear(field)
    await userEvent.type(field, 'Beach House')
    await userEvent.tab()

    await waitFor(() => expect(screen.getByTestId('portal-title-error')).toBeTruthy())
    expect(field.value).toBe('Guest Portal')
  })

  it('closes', async () => {
    const onClose = vi.fn()
    render(<SettingsPanel onClose={onClose} />)
    await userEvent.click(await screen.findByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it('uses no hardcoded colours — every colour comes from a token', () => {
    for (const f of ['SettingsPanel', 'PortalTitleField']) {
      const src = readFileSync(`src/web/components/${f}.tsx`, 'utf-8')
      expect(src, f).not.toMatch(
        /\b(bg|text|border)-(gray|blue|red|green|yellow|indigo|purple|pink|slate|zinc)-\d{2,3}\b/,
      )
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(src, f).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/)
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/settings-panel.test.tsx`
Expected: FAIL — cannot resolve `SettingsPanel.tsx`.

- [ ] **Step 3: Write `PortalTitleField`**

Create `src/web/components/PortalTitleField.tsx`. Requirements:

- a labelled input, label text **Portal name**, initial value from `getAdminPortal()` (falling back to `readPortalTitle()` while loading)
- **commits on blur and on Enter, not on every keystroke** — a PUT per character would hammer the server and the responses could land out of order
- on success keep the value; on failure restore the previous value and render an error with `data-testid="portal-title-error"`
- token-styled

Note the existing `ThemePicker` and `PortalToggle` already fetch `getAdminPortal()` themselves. Leaving that duplication is fine for now: three small independent fetches on opening a settings panel is cheaper than inventing a shared provider, and each already handles its own load failure with a retry.

- [ ] **Step 4: Write `SettingsPanel`**

Create `src/web/components/SettingsPanel.tsx`: a token-styled overlay panel containing `PortalTitleField`, `ThemePicker` and `PortalToggle`, with a **Close** button calling `onClose`. Convert `ThemePicker` and `PortalToggle`'s inline hex styles to `var(--token)` in this task so the panel is visually coherent — that is the remaining part of the "owner surfaces read tokens" decision.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run test/unit/settings-panel.test.tsx`
Expected: PASS, 6 tests. The existing `theme-picker.test.tsx` and `portal-toggle-ui.test.tsx` must still pass unmodified — you changed those components' colours, not their behaviour.

- [ ] **Step 6: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add src/web/components test/unit/settings-panel.test.tsx
git commit -m "feat: add the settings panel"
```

---

## Task 8: The one page

**Files:**
- Create: `src/web/routes/Portal.tsx`, `test/unit/portal-page.test.tsx`
- Delete: `src/web/routes/Guest.tsx` (renamed)
- Modify: `src/web/App.tsx`, `test/unit/guest-ui.test.tsx` (import path only)

**Interfaces:**
- Consumes: everything from Tasks 3–7.
- Produces: `export function Portal({ role, onLogout }: { role: Role; onLogout: () => Promise<void> }): ReactElement`

- [ ] **Step 1: Write the failing test**

Create `test/unit/portal-page.test.tsx` covering:

```
- an owner sees Edit and Settings in the header; a guest sees neither
- clicking Edit reveals the ghost "Add device" tile; leaving edit mode hides it
- in edit mode, clicking a tile opens that device's editor rather than actuating it
- clicking Settings opens the settings panel
- opening Settings while editing closes edit mode, and vice versa (mutually exclusive)
- the header shows the injected portal title
- a device that disappears from the store while its editor is open closes the
  editor instead of editing a ghost
```

Drive these through the rendered page with `getByRole`, not by inspecting props. Set `document.documentElement.dataset.portalTitle` in the title test and clear it in `afterEach`. Mock the device store the way `guest-ui.test.tsx` already does.

For the last case, open a tile's editor, then re-render with that device absent from the store — as an incoming SSE snapshot would after another session removed it — and assert the editor is gone. Without this the owner edits a row that no longer exists and the next mutation resurrects it.

The mutants to keep in mind: a page that always shows the buttons (guest case fails), a page where edit mode still actuates (tile-click case fails), one where both overlays can stack (exclusivity case fails), and one that keeps the editor keyed by a stale row object (ghost case fails).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/portal-page.test.tsx`
Expected: FAIL — cannot resolve `Portal.tsx`.

- [ ] **Step 3: Rename and extend**

```bash
git mv src/web/routes/Guest.tsx src/web/routes/Portal.tsx
```

Rename the component `Guest` → `Portal` and its props type `GuestProps` → `PortalProps`. Keep `DeviceTile` module-scoped for the reason its existing comment gives — a component defined during render remounts the grid and discards each tile's optimistic state.

Add to `Portal`:

- `role: Role` in props; `const isOwner = role === 'admin'`
- `const [mode, setMode] = useState<'normal' | 'edit' | 'settings'>('normal')` — one piece of state, so the overlays are mutually exclusive by construction rather than by coordination
- `const editor = useAllowlistEditor(devices)`
- `headerActions` built only when `isOwner`: two buttons toggling `mode`
- `title={readPortalTitle()}` on the `Shell`
- in edit mode, wrap each tile so a click opens `TileEditor` for that row instead of reaching the tile, and append a ghost tile that opens the entity picker
- render `<SettingsPanel onClose={() => setMode('normal')} />` when `mode === 'settings'`

The ghost tile fetches the catalog with `getCatalog()` when opened and renders the existing `EntityPicker`, excluding entity ids already present. Selecting one calls `editor.add(entry)`.

The shape to aim for:

```tsx
export function Portal({ role, onLogout }: PortalProps): ReactElement {
  const [loggingOut, setLoggingOut] = useState(false)
  // One piece of state, so Edit and Settings are mutually exclusive by
  // construction rather than by two booleans kept in step.
  const [mode, setMode] = useState<'normal' | 'edit' | 'settings'>('normal')
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    const teardown = connectDeviceStore()
    return teardown
  }, [])

  const { devices, connected } = useDeviceStore()
  const editor = useAllowlistEditor(devices)
  const isOwner = role === 'admin'
  const components = componentsFor(activeTheme())
  const { Shell } = components

  // The row being edited is looked up fresh each render. If another session
  // removes it, the incoming snapshot drops it and the editor closes rather
  // than editing a device that no longer exists.
  const editingRow = editingId === null ? undefined : editor.rows.find((r) => r.entityId === editingId)

  const headerActions = isOwner ? (
    <>
      <button type="button" onClick={() => setMode(mode === 'edit' ? 'normal' : 'edit')}>
        {mode === 'edit' ? 'Done' : 'Edit'}
      </button>
      <button type="button" onClick={() => setMode(mode === 'settings' ? 'normal' : 'settings')}>
        Settings
      </button>
    </>
  ) : undefined

  return (
    <Shell
      title={readPortalTitle()}
      loggingOut={loggingOut}
      onLogout={() => {
        void handleLogout()
      }}
      headerActions={headerActions}
    >
      {/* grid, ghost tile when mode === 'edit', overlays */}
    </Shell>
  )
}
```

Leaving edit mode must also clear `editingId`, or reopening edit mode reopens the last editor.

Style the two header buttons from tokens, as with the other owner surfaces — they sit inside a themed header.

- [ ] **Step 4: Update `App.tsx`**

Delete the `Admin` import, the `currentPath` / `isAdminPath` block and the `/admin` branch. Render `<Portal role={role} onLogout={handleLogout} />` for both roles.

- [ ] **Step 5: Run everything**

Run: `pnpm vitest run`
Expected: PASS. `guest-ui.test.tsx` needs its import path updated to `Portal.tsx` and `role="guest"` supplied — **an import fix and a required prop, nothing else.** Its ~30 assertions must survive untouched; they are the evidence the guest surface did not change. If one fails, the page is wrong.

- [ ] **Step 6: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add src/web test/unit
git commit -m "feat: merge admin and guest onto one page"
```

---

## Task 9: Delete the admin page

**Files:**
- Delete: `src/web/routes/Admin.tsx`, `test/unit/admin-screen.test.tsx`
- Modify: `test/unit/web-components.test.tsx`, `test/e2e/portal.spec.ts`, `test/integration/routes-guest.test.ts`

- [ ] **Step 1: Confirm the behaviour survived before deleting anything**

For each of the 15 tests in `test/unit/admin-screen.test.tsx`, find the test that now covers it in `allowlist-editor.test.tsx`, `tile-editor.test.tsx`, `settings-panel.test.tsx` or `portal-page.test.tsx`. **Write the mapping into the commit message.** Any behaviour with no new home is a gap — port it before deleting, do not drop it.

- [ ] **Step 2: Delete**

```bash
git rm src/web/routes/Admin.tsx test/unit/admin-screen.test.tsx
```

- [ ] **Step 3: Remove the `/admin` tests**

In `test/unit/web-components.test.tsx`, remove the four tests that stub `window.location.pathname = '/admin'` and assert the admin screen renders. There is no such screen and no such path; these are not behaviour being moved.

In `test/e2e/portal.spec.ts`, replace every `page.goto(\`${baseUrl}/admin\`)` with clicking the **Settings** or **Edit** button on the page the owner is already on. This exercises the real affordance instead of deep-linking past it.

In `test/integration/routes-guest.test.ts`, the SPA-fallback and injection tests that use `/admin` as a path stay — the server still serves `index.html` for any non-API path. Reword their names so they no longer imply an admin page exists (e.g. "injects data-theme and base href on a non-root path").

- [ ] **Step 4: Run everything, including e2e**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run && pnpm build && pnpm test:e2e`
Expected: PASS. Restore `test/e2e/screenshots/*.png` afterwards or commit them separately.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add -A
git commit
# Commit message must contain the 15-test mapping from Step 1.
```

---

## Task 10: Documentation

**Files:**
- Modify: `README.md`, `DOCS.md`, `docs/DECISIONS.md`, `scripts/dev-demo.sh`

- [ ] **Step 1: Update the owner-facing docs**

`DOCS.md`: replace any description of a separate admin page with the new model — owners see **Edit** and **Settings** on the portal itself; Edit lets you rename devices, choose what guests can do with them, reorder them, remove them and add new ones; Settings holds the theme, the on/off switch and the portal name. Add that the portal name appears in the header and the browser tab, and that clearing it restores `Guest Portal`.

`README.md`: update the First-Run Setup steps that mention `/admin` or an Admin link.

`scripts/dev-demo.sh`: remove the two `Admin screen  http://localhost:5173/admin` lines.

- [ ] **Step 2: Record the decisions**

Append to `docs/DECISIONS.md`, matching its voice (bolded claim, reasoning, cost of reversal):

- **Owners edit the portal itself, not a separate admin page.** You cannot tell what you are shipping from a screen that looks nothing like it. Reversing means reintroducing a surface that duplicates the themed grid.
- **Edits save immediately; there is no Save button.** The page holds a live SSE stream, so batching would mean reconciling every incoming snapshot against uncommitted local edits. Instant save keeps the stream authoritative. The cost is no undo, which is why removal confirms.
- **A newly added device has no allowed actions.** It appears to guests as an inert "No actions available" tile until configured — visible but not operable. The alternative, a persisted hidden flag, adds a column and a visibility concept to solve a cosmetic problem.
- **The portal title is injected, not fetched.** Same mechanism and same reasoning as the theme: correct on first paint, and no public endpoint needed to serve one string to guests. It is owner-supplied text written into HTML, so it is escaped at the injection point and tested with a hostile value.
- **Owner surfaces read theme tokens but are not theme components.** They adopt each theme's palette automatically, including future themes, without adding slots — so a theme is still one folder. This reverses the earlier "the admin surface is not themed", which was right for a separate page and wrong for a dialog opening over a themed grid.
- **Reordering uses arrows, not drag.** Drag is the most fragile part of this on touch and the hardest to make accessible; arrows work with a keyboard and a screen reader. Adding drag later is a pure enhancement with no data implications.

Under known gaps: **two owners editing at once will clobber each other**, because every edit PUTs the whole allowlist. Acceptable for a single-household add-on; the fix is per-device endpoints or an ETag.

- [ ] **Step 3: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add README.md DOCS.md docs/DECISIONS.md scripts/dev-demo.sh
git commit -m "docs: document the single-page portal"
```

---

## Verification Checklist

```bash
pnpm lint                      # zero errors AND zero warnings
pnpm typecheck
pnpm vitest run                # no it.fails, no it.skip
pnpm build && pnpm test:e2e
pnpm format                    # must report no fixes
git status --short             # must be empty
grep -rn "/admin" --exclude-dir=node_modules --exclude-dir=dist . | grep -v "api/admin"
```

The last command should return nothing but the integration tests' non-API path cases.

Manual checks automation cannot cover:

- [ ] A guest sees no trace of Edit or Settings — not disabled, absent.
- [ ] Adding a device in edit mode appears on a second browser as an inert tile within a second or two.
- [ ] Renaming the portal changes the header and the browser tab on the guest's next load.
- [ ] Edit mode is unmistakable at phone width; a mis-tap cannot silently actuate a lock.
- [ ] Each theme's header still looks right with two extra buttons in it.
