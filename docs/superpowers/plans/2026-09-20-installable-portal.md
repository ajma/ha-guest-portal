# Installable Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The portal installs to a home screen, and opening it where the portal cannot be reached shows the portal's own "can't reach it" screen instead of the browser's error page.

**Architecture:** Three independent pieces. Committed icons plus a static manifest make it installable. A new `unreachable` state in `App` distinguishes "the request rejected" from "the request said no session", and renders a themed screen with Retry. A small service worker caches the shell at runtime so that screen has something to render from when the network is gone; it never touches `/api/*`.

**Tech Stack:** TypeScript, React 19, Vite 8, Hono, vitest + happy-dom, Playwright, Biome. ImageMagick (`/usr/bin/convert`) for one-off icon generation.

**Spec:** `docs/superpowers/specs/2026-09-20-installable-portal-design.md`

## Global Constraints

- Biome must report **zero errors and zero warnings**: `pnpm lint`. No non-null assertions (`!`).
- `pnpm typecheck` clean across all three tsconfigs. `pnpm format` must leave the tree unchanged (it is not part of `pnpm lint`).
- Baseline before this plan: **878 unit tests, 0 expected-fail, 52 files; 8 e2e passing.** No `it.fails` / `it.skip` may be introduced.
- **No API response is ever cached.** Not device state, not the session, not the catalog. A cached `/api/devices` would show a guest a lock reading "Locked" as of an hour ago. The service worker must not intercept `/api/*` at all.
- Service worker registration is a progressive enhancement: if it fails, or the browser lacks support, or the context is insecure, **the app must boot exactly as it does now**.
- The build uses a **relative base** (`vite.config.ts`: `base: command === 'build' ? './' : '/'`) so the app works under Home Assistant ingress. Asset references in `index.html` are `./assets/…`, resolved against a `<base href>` the server injects.
- `src/web/` may use the `@shared/*` alias (Vite rewrites it). `src/server/` must NOT — it is built by plain `tsc`, which emits aliases unchanged and they fail at runtime.
- Plain author commits only. **Never** add a `Co-Authored-By` trailer, a "Generated with Claude" footer, a 🤖 line, or any AI-attribution anywhere.
- Do not run `pnpm dev` or `pnpm dev:real`, start Docker containers, or use `sudo`. A dev stack is live on ports 9123/5173. `pnpm build` and `pnpm test:e2e` are allowed where a task says so.
- `test/e2e/screenshots/*.png` are rewritten by every e2e run — restore them (`git checkout --`) or commit them separately.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `public/manifest.webmanifest` | Name, `start_url`, `display`, colours, icon list. Static; copied verbatim by Vite. |
| `public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Committed, generated once from `brand/icon.png`. |
| `scripts/generate-icons.sh` | Reproduces those PNGs. Not run at build time — see Task 1. |
| `public/sw.js` | The service worker. Plain JS, copied verbatim, never bundled. |
| `src/web/registerServiceWorker.ts` | The guarded registration call, so `main.tsx` stays three lines and the guard is testable. |
| `src/web/themes/default/Unreachable.tsx` | The themed "can't reach the portal" screen. |
| `test/unit/register-service-worker.test.ts` | The registration guard. |
| `test/unit/unreachable-screen.test.tsx` | The screen and the `App` state that selects it. |
| `test/integration/pwa-assets.test.ts` | `/sw.js` and `/manifest.webmanifest` are served at the root, ahead of the SPA fallback. |
| `test/e2e/offline.spec.ts` | The actual requirement: install, go offline, reload, see the screen. |

**Modified**

| File | Change |
|---|---|
| `index.html` | Manifest link, `apple-touch-icon`, `theme-color`. |
| `src/web/main.tsx` | Call the registration. |
| `src/web/App.tsx` | Third session state: `unreachable`, plus Retry. |
| `src/web/themes/types.ts` | `UnreachableProps`, optional `Unreachable` slot. |
| `src/web/themes/default/index.ts` | Export `Unreachable` in `DEFAULT_COMPONENTS`. |
| `test/unit/theme-default-components.test.tsx` | The slot inventory gains `Unreachable`. |
| `README.md`, `DOCS.md`, `docs/DECISIONS.md` | Document installing it, and the caching decision. |

---

## Task 1: Icons, manifest, and the `<head>` wiring

**Files:**
- Create: `public/manifest.webmanifest`, `public/icons/{icon-192,icon-512,icon-maskable-512}.png`, `scripts/generate-icons.sh`, `test/unit/manifest.test.ts`
- Modify: `index.html`

**Interfaces:**
- Consumes: `brand/icon.png` (256×256, RGB).
- Produces: `/manifest.webmanifest` and `/icons/*.png` in the build output.

**Why the icons are committed, not generated at build time.** The production image is built by Docker and cannot be assumed to have ImageMagick. A build step that silently produces no icons would leave the app uninstallable with everything green. The script exists to make the PNGs reproducible; the PNGs are the artefact.

- [ ] **Step 1: Write the failing test**

Create `test/unit/manifest.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The fields a browser actually requires before it will offer to install.
// Asserting the file merely parses would pass for `{}`.
describe('web app manifest', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf-8')) as {
    name: string
    short_name: string
    start_url: string
    display: string
    background_color: string
    theme_color: string
    icons: { src: string; sizes: string; type: string; purpose?: string }[]
  }

  it('names the app', () => {
    expect(manifest.name.length).toBeGreaterThan(0)
    // Home screens truncate around 12 characters.
    expect(manifest.short_name.length).toBeLessThanOrEqual(12)
  })

  it('opens standalone at the root', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
  })

  it('declares the icon sizes installability requires', () => {
    const sizes = manifest.icons.map((i) => i.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
  })

  it('declares a maskable icon, so Android does not letterbox it', () => {
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true)
  })

  it('points every icon at a file that exists', () => {
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) {
      // `src` is site-relative; the files live under public/.
      expect(existsSync(`public${icon.src}`), icon.src).toBe(true)
    }
  })

  it('links the manifest and an apple-touch-icon from the document head', () => {
    // iOS ignores the manifest's icons and uses apple-touch-icon only.
    const html = readFileSync('index.html', 'utf-8')
    expect(html).toMatch(/<link[^>]+rel="manifest"/)
    expect(html).toMatch(/<link[^>]+rel="apple-touch-icon"/)
    expect(html).toMatch(/<meta[^>]+name="theme-color"/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/manifest.test.ts`
Expected: FAIL — `public/manifest.webmanifest` does not exist.

- [ ] **Step 3: Generate the icons**

Create `scripts/generate-icons.sh`:

```bash
#!/usr/bin/env bash
# Regenerates the PWA icons from brand/icon.png.
#
# The output is COMMITTED and this is not run by the build: the production
# image is built by Docker, which cannot be assumed to have ImageMagick, and a
# build step that quietly produced no icons would leave the app uninstallable
# with every check green.
#
# The 512 is an upscale from a 256 source and will be slightly soft. Replace
# brand/icon.png with a larger original if that ever matters.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p public/icons
convert brand/icon.png -resize 192x192 public/icons/icon-192.png
convert brand/icon.png -resize 512x512 public/icons/icon-512.png

# Maskable: Android crops to a circle and clips ~10% off each edge, so the
# artwork is inset onto a full-bleed background rather than run to the edge.
convert brand/icon.png -resize 410x410 \
  -background '#fafafa' -gravity center -extent 512x512 \
  public/icons/icon-maskable-512.png

echo "wrote public/icons/"
```

Run: `chmod +x scripts/generate-icons.sh && ./scripts/generate-icons.sh`

Confirm the three files exist and are non-trivial (`ls -l public/icons/` — each should be more than a few hundred bytes).

- [ ] **Step 4: Write the manifest**

Create `public/manifest.webmanifest`:

```json
{
  "name": "Home Assistant Guest Portal",
  "short_name": "Guest",
  "description": "Control the devices your host has shared with you.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#fafafa",
  "theme_color": "#fafafa",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    {
      "src": "/icons/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}
```

`background_color` and `theme_color` are `#fafafa` — the `classic` theme's `appBg`. They are read by the OS before any stylesheet loads, so they cannot follow the owner's chosen theme.

- [ ] **Step 5: Wire the document head**

In `index.html`, inside `<head>`:

```html
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icons/icon-192.png" />
    <meta name="theme-color" content="#fafafa" />
```

These are absolute (`/…`), unlike the bundled assets, which Vite rewrites to `./…`. That is deliberate: the manifest and its icons are fetched by the OS rather than by the page, and a relative URL would resolve against whatever path the document was loaded from.

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm vitest run test/unit/manifest.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Confirm the build copies them**

Run: `pnpm build`
Then: `ls dist/web/manifest.webmanifest dist/web/icons/`
Expected: all four files present. Vite copies `public/` verbatim; if the directory did not exist before this task, confirm it was picked up rather than assuming.

- [ ] **Step 8: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add public scripts/generate-icons.sh index.html test/unit/manifest.test.ts
git commit -m "feat: make the portal installable"
```

---

## Task 2: The unreachable state

**Files:**
- Create: `src/web/themes/default/Unreachable.tsx`, `test/unit/unreachable-screen.test.tsx`
- Modify: `src/web/themes/types.ts`, `src/web/themes/default/index.ts`, `src/web/App.tsx`, `test/unit/theme-default-components.test.tsx`

**Interfaces:**
- Consumes: `componentsFor`, `activeTheme` from `src/web/themes/active.js`; `getSession` from `src/web/api.js`.
- Produces: `UnreachableProps = { onRetry: () => void }`; `Unreachable` in `DEFAULT_COMPONENTS`; `Theme['components'].Unreachable?`.

**The defect this fixes.** `App.tsx:29-39` calls `void checkSession()` with no `catch`. `getSession()` does a bare `await fetch(...)` and returns `null` only for a 401, so a **network** failure rejects, `setRole` is never called, and the app sits on `Loading...` forever (`App.tsx:92`) with an unhandled rejection in the console. Off-network today is a permanent spinner, not a login form.

**Why a new slot rather than reusing `Disabled`.** Different copy for a different cause: `Disabled` means the owner switched the portal off, `Unreachable` means we could not ask. The slot is **optional** and `componentsFor` merges over the defaults, so no existing theme has to supply one — adding it costs a theme nothing. That is the property that keeps a theme to one folder.

- [ ] **Step 1: Write the failing test**

Create `test/unit/unreachable-screen.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/web/App.tsx'
import * as api from '../../src/web/api.ts'

vi.mock('../../src/web/api.ts')

describe('unreachable portal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.setUnauthorizedCallback).mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the unreachable screen when the session request rejects', async () => {
    // A rejection is a *network* failure: no connection, DNS, refused. Before
    // this existed the rejection escaped `void checkSession()` and the app sat
    // on Loading... forever.
    vi.mocked(api.getSession).mockRejectedValue(new TypeError('Failed to fetch'))

    render(<App />)

    expect(await screen.findByText(/can't reach the guest portal/i)).toBeTruthy()
    expect(screen.getByText(/home wi-?fi/i)).toBeTruthy()
  })

  it('shows the login form when the portal answers with no session', async () => {
    // The discriminating pair: answered-but-unauthenticated must NOT look like
    // unreachable. A mutant treating both the same fails exactly here.
    vi.mocked(api.getSession).mockResolvedValue(null)

    render(<App />)

    expect(await screen.findByLabelText(/password/i)).toBeTruthy()
    expect(screen.queryByText(/can't reach the guest portal/i)).toBeNull()
  })

  it('never leaves the app on the loading state after a rejection', async () => {
    vi.mocked(api.getSession).mockRejectedValue(new TypeError('Failed to fetch'))

    render(<App />)

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull())
  })

  it('retries and recovers', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getSession).mockRejectedValueOnce(new TypeError('Failed to fetch'))

    render(<App />)
    await screen.findByText(/can't reach the guest portal/i)

    vi.mocked(api.getSession).mockResolvedValue(null)
    await user.click(screen.getByRole('button', { name: /retry/i }))

    expect(await screen.findByLabelText(/password/i)).toBeTruthy()
  })

  it('does not leak an unhandled rejection', async () => {
    // The rejection must be caught, not merely survived. vitest fails the run
    // on an unhandled rejection, so this asserts the absence by completing.
    vi.mocked(api.getSession).mockRejectedValue(new TypeError('Failed to fetch'))

    render(<App />)
    await screen.findByText(/can't reach the guest portal/i)
  })
})
```

Check how `web-components.test.tsx` mocks `src/web/api.ts` and follow the same approach; if `setUnauthorizedCallback` needs other members stubbed, stub them.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/unreachable-screen.test.tsx`
Expected: FAIL — no such screen; likely a timeout on the first assertion, since the app stays on `Loading...`.

- [ ] **Step 3: Add the slot to the contract**

In `src/web/themes/types.ts`:

```ts
export type UnreachableProps = { onRetry: () => void }
```

and inside `Theme['components']`:

```ts
    Unreachable?: ComponentType<UnreachableProps>
```

- [ ] **Step 4: Write the default screen**

Create `src/web/themes/default/Unreachable.tsx`. Requirements — write it in the idiom of `src/web/themes/default/Disabled.tsx`, which is the closest neighbour:

- heading: `Can't reach the guest portal`
- body: `You may need to be on the home Wi-Fi. This screen also appears if the portal has been switched off at the router or the add-on is not running.`
- a **Retry** button calling `onRetry`
- `data-testid="portal-unreachable-screen"`
- every colour from `var(--token)`; no hex, no Tailwind palette classes, no `'white'`/`'black'`

The copy states the likely cause without asserting it. We detect "the portal did not answer", not "you are away from home" — the portal is reachable over a VPN from anywhere, and unreachable from the sofa when the add-on is stopped.

Export it from `src/web/themes/default/index.ts` in `DEFAULT_COMPONENTS`, and add `'Unreachable'` to the slot list in `test/unit/theme-default-components.test.tsx`'s inventory test.

- [ ] **Step 5: Add the state to `App`**

In `src/web/App.tsx`, widen the state and catch the rejection:

```tsx
  const [role, setRole] = useState<Role | null | 'loading' | 'unreachable'>('loading')
```

```tsx
  const checkSession = useCallback(async (): Promise<void> => {
    try {
      const session = await getSession()
      setRole(session?.role ?? null)
      if (session !== null) {
        setPortalEnabled(session.portalEnabled)
      }
    } catch {
      // A rejection is a network failure — no connection, DNS, refused. An
      // answered request that happens to be a 401 returns null above and means
      // something completely different: the portal is there and wants a
      // password. Conflating them shows a guest a login form that cannot work,
      // or worse, the spinner this used to hang on.
      setRole('unreachable')
    }
  }, [])

  useEffect(() => {
    void checkSession()
  }, [checkSession])
```

and render it before the `role === null` branch:

```tsx
  if (role === 'unreachable') {
    return (
      <Unreachable
        onRetry={() => {
          setRole('loading')
          void checkSession()
        }}
      />
    )
  }
```

taking `Unreachable` from the same `componentsFor(activeTheme())` destructure that already yields `Login` and `Disabled`.

Check the other `getSession()` call sites in this file (the reconnect check and the portal-enabled poll). They are inside effects and have the same exposure; wrap them too, or say why not.

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm vitest run test/unit/unreachable-screen.test.tsx`
Expected: PASS, 5 tests. Then `pnpm vitest run` — the whole suite, with **zero unhandled errors**.

- [ ] **Step 7: Prove the tests discriminate**

Run each mutant, confirm the named test fails, revert. **Use a /tmp copy, never `git checkout`** — an earlier task in this repo wiped its own unstaged work that way.

1. `catch { setRole(null) }` → "shows the login form when the portal answers with no session" still passes, but "shows the unreachable screen" fails. This is the mutant that matters: it is the bug being fixed.
2. Remove the `try`/`catch` entirely → "never leaves the app on the loading state" fails **and** vitest reports an unhandled rejection.
3. Retry does not reset to `'loading'` before re-checking → confirm whether any test fails; if none does, the reset is unpinned and you should say so rather than leave it.

- [ ] **Step 8: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add src/web test/unit
git commit -m "feat: tell a guest when the portal cannot be reached"
```

---

## Task 3: The service worker

**Files:**
- Create: `public/sw.js`, `src/web/registerServiceWorker.ts`, `test/unit/register-service-worker.test.ts`, `test/integration/pwa-assets.test.ts`, `test/e2e/offline.spec.ts`
- Modify: `src/web/main.tsx`, `biome.json` (only if the service-worker globals trip the linter)

**Interfaces:**
- Consumes: nothing.
- Produces: `registerServiceWorker(): void`.

**Runtime caching, not a precache manifest.** The worker caches same-origin GETs as they are fetched, rather than being handed a build-time list of hashed filenames. That avoids generating an asset manifest and keeps `sw.js` a file you can read in one sitting. The trade is real and acceptable: the shell is only available offline after the app has been opened online once — which is exactly the install flow, since you install it by visiting it.

- [ ] **Step 1: Write the failing registration test**

Create `test/unit/register-service-worker.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerServiceWorker } from '../../src/web/registerServiceWorker.ts'

describe('registerServiceWorker', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('registers when the browser supports it', () => {
    const register = vi.fn().mockResolvedValue({})
    vi.stubGlobal('navigator', { serviceWorker: { register } })

    registerServiceWorker()

    expect(register).toHaveBeenCalledWith('/sw.js')
  })

  it('does nothing when the browser has no service worker support', () => {
    // Safari in a private window, and any insecure context. Must not throw.
    vi.stubGlobal('navigator', {})

    expect(() => {
      registerServiceWorker()
    }).not.toThrow()
  })

  it('swallows a failed registration rather than breaking boot', async () => {
    // Registration is a progressive enhancement. An insecure context rejects
    // here, and the app must still start. An unhandled rejection would also
    // fail this suite.
    const register = vi.fn().mockRejectedValue(new Error('insecure context'))
    vi.stubGlobal('navigator', { serviceWorker: { register } })

    registerServiceWorker()
    await Promise.resolve()
    await Promise.resolve()

    expect(register).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/unit/register-service-worker.test.ts`
Expected: FAIL — cannot resolve `registerServiceWorker.ts`.

- [ ] **Step 3: Write the registration**

Create `src/web/registerServiceWorker.ts`:

```ts
/**
 * Registering is a progressive enhancement and must never block boot: no
 * support, an insecure context, or a rejected registration all leave the app
 * working exactly as it does without a worker.
 *
 * `/sw.js` is absolute on purpose. The scope of a worker is the directory it is
 * served from, so a worker registered from a subpath would not control the
 * root, and the built assets use a relative base for ingress.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return

  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Deliberately silent. There is nothing a guest can do about it, and the
    // portal works without it.
  })
}
```

In `src/web/main.tsx`, call it after the render, guarded to production:

```tsx
if (import.meta.env.PROD) {
  registerServiceWorker()
}
```

Registering under `vite dev` would serve a stale shell over the dev server, which is an hour of confusion for no benefit.

`src/web/vite-env.d.ts` already carries `/// <reference types="vite/client" />`, which should type `import.meta.env`. If `pnpm typecheck` disagrees, add the same triple-slash reference to the top of `main.tsx` — `src/web/components/ThemePicker.tsx:1` already does exactly that, so there is precedent rather than a new pattern.

`useCallback` is already imported in `App.tsx`; no import change is needed there.

- [ ] **Step 4: Write the worker**

Create `public/sw.js`:

```js
// The portal's offline shell.
//
// Caches same-origin static GETs as they are fetched, so that opening the
// installed app without a connection renders the portal's own "can't reach it"
// screen instead of the browser's error page.
//
// It does NOT cache any API response. A cached /api/devices would show a guest
// a lock reading "Locked" as of an hour ago — a confident, stale claim about a
// lock. Showing nothing is better than showing something false.
//
// Bump CACHE whenever what gets cached changes; `activate` drops every other
// cache, which is how an old shell is evicted.
const CACHE = 'portal-shell-v1'

self.addEventListener('install', (event) => {
  // Take over as soon as possible rather than waiting for every tab to close.
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  // Someone else's origin, or a write. Not ours to touch.
  if (url.origin !== self.location.origin) return
  if (request.method !== 'GET') return

  // Never the API. Not cached, not intercepted — it fails as the network fails,
  // which is what the unreachable screen is waiting for.
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    // Network-first: a reachable portal always wins, so an add-on update is
    // picked up on the next online load instead of being pinned by the cache.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(CACHE).then((cache) => cache.put('/', copy))
          }
          return response
        })
        .catch(() => caches.match('/').then((hit) => hit ?? Response.error())),
    )
    return
  }

  // Everything else is a static asset with a content-hashed name, so a cache
  // hit is always correct.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        }),
    ),
  )
})
```

If Biome objects to `self` or the service-worker globals in this file, add a narrow override for `public/sw.js` in `biome.json` rather than loosening a rule globally, and say in the commit message which rule and why.

- [ ] **Step 5: Write the serving test**

Create `test/integration/pwa-assets.test.ts`. It must assert that `/sw.js` and `/manifest.webmanifest` are answered from the build output **and not** by the SPA fallback — the fallback returns `index.html` for any non-API path, so a missing file would still return 200 with HTML, and a naive status check would pass.

Model it on `test/integration/routes-guest.test.ts`'s static-serving tests, which already build an app against a temp `webRoot` via `cfg.webRoot`. Write the files into that temp root:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WEB_ROOT = mkdtempSync(join(tmpdir(), 'portal-pwa-'))

beforeAll(() => {
  writeFileSync(join(WEB_ROOT, 'index.html'), '<!DOCTYPE html>\n<html lang="en"><head></head><body></body></html>')
  writeFileSync(join(WEB_ROOT, 'sw.js'), "const CACHE = 'portal-shell-v1'\n")
  writeFileSync(join(WEB_ROOT, 'manifest.webmanifest'), JSON.stringify({ name: 'Home Assistant Guest Portal' }))
  mkdirSync(join(WEB_ROOT, 'icons'), { recursive: true })
  writeFileSync(join(WEB_ROOT, 'icons', 'icon-192.png'), 'not-really-a-png')
})

afterAll(() => {
  rmSync(WEB_ROOT, { recursive: true, force: true })
})
```

and build the runtime with `webRoot: WEB_ROOT` in `cfg`, exactly as `routes-guest.test.ts` does. Then:

```ts
  it('serves the service worker itself, not the SPA shell', async () => {
    const res = await fetch(`${baseUrl}/sw.js`)
    expect(res.status).toBe(200)

    const text = await res.text()
    // The SPA fallback answers any non-API path with index.html, so a status
    // check alone passes even when the file is missing entirely. Assert on the
    // body, and on the absence of the shell.
    expect(text).toContain('portal-shell-v1')
    expect(text).not.toContain('<!DOCTYPE')
  })

  it('serves the manifest as JSON, not the SPA shell', async () => {
    const res = await fetch(`${baseUrl}/manifest.webmanifest`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { name: string }
    expect(body.name).toBe('Home Assistant Guest Portal')
  })

  it('serves an icon rather than the shell', async () => {
    const res = await fetch(`${baseUrl}/icons/icon-192.png`)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain('<!DOCTYPE')
  })

  it('still falls back to the shell for a path that is not a file', async () => {
    // The control: without it the three above would also pass if static
    // serving had swallowed everything, including routes that should fall back.
    const res = await fetch(`${baseUrl}/some/guest/route`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<!DOCTYPE')
  })
```

- [ ] **Step 6: Write the offline e2e — this is the real test**

Create `test/e2e/offline.spec.ts`. Playwright can take the browser offline, so the requirement can be tested end to end rather than argued about:

```ts
test('an installed portal explains itself when it cannot be reached', async ({ page, context }) => {
  await page.goto(harness.baseUrl)
  await page.getByLabel('Password').fill('test-guest-password')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByTestId('guest-screen')).toBeVisible()

  // The worker controls the page only after it activates.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)

  await context.setOffline(true)
  await page.reload()

  await expect(page.getByTestId('portal-unreachable-screen')).toBeVisible()
  await expect(page.getByText(/can't reach the guest portal/i)).toBeVisible()

  await context.setOffline(false)
  await page.getByRole('button', { name: /retry/i }).click()
  await expect(page.getByTestId('guest-screen')).toBeVisible()
})
```

The mutant this kills: a worker that caches `/api/*`. With API responses cached, the reload would restore the device grid from cache instead of showing the unreachable screen, and this test fails — which is the guarantee the spec cares most about. Verify that by temporarily removing the `/api/` guard from `sw.js` and confirming this test fails.

Service workers need a secure context; `127.0.0.1` counts as one, so the harness works unmodified.

- [ ] **Step 7: Run everything**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run && pnpm build && pnpm test:e2e`

- [ ] **Step 8: Commit**

```bash
pnpm format
git add public/sw.js src/web test/unit test/integration test/e2e biome.json
git commit -m "feat: cache the shell so the portal can explain itself offline"
```

---

## Task 4: Documentation

**Files:**
- Modify: `README.md`, `DOCS.md`, `docs/DECISIONS.md`

- [ ] **Step 1: Document installing it**

`DOCS.md` gains a short "Add the portal to your home screen" section for owners to pass on: on iOS, Share → Add to Home Screen; on Android and desktop Chrome, an install prompt or the address-bar icon. Say that it opens without browser chrome, and that it only works while the device can reach the portal — with a note that the app will say so plainly if it cannot.

`README.md`: one line in the feature list.

- [ ] **Step 2: Record the decisions**

Append to `docs/DECISIONS.md`, matching its voice (bolded claim, reasoning, cost of reversal):

- **No API response is ever cached.** A cached device list would show a guest a lock reading "Locked" as of an hour ago. Showing nothing beats showing something false about a lock, so the worker passes `/api/*` straight through and lets it fail.
- **The offline screen says "can't reach", not "you're not home".** We detect that the portal did not answer. It is reachable over a VPN from anywhere and unreachable from the sofa when the add-on is stopped, so the screen names the likely cause without claiming to have measured it.
- **Icons are committed, not generated during the build.** The production image is built by Docker, which cannot be assumed to have ImageMagick; a build step that silently produced no icons would leave the app uninstallable with every check green.
- **The service worker caches at runtime rather than from a build manifest.** The shell is available offline only after one online visit — which is the install flow anyway — and in exchange `sw.js` stays short enough to read in one sitting.
- Under known gaps: **`theme_color` cannot follow the chosen theme.** The OS reads it before any stylesheet loads, so it is fixed to the default theme's background.
- Under known gaps: **a LAN-only restriction was designed and dropped.** Under the add-on's Docker bridge networking the container may see the bridge gateway's address rather than the client's, and that address is itself private — so the gate would have passed everything while appearing to work. The portal remains reachable from any network that can route to it, governed by the password.

- [ ] **Step 3: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`

```bash
pnpm format
git add README.md DOCS.md docs/DECISIONS.md
git commit -m "docs: document installing the portal"
```

---

## Verification Checklist

```bash
pnpm lint                      # zero errors AND zero warnings
pnpm typecheck
pnpm vitest run                # no it.fails, no it.skip, zero unhandled
pnpm build && pnpm test:e2e
pnpm format                    # must report no fixes
git status --short             # must be empty
```

Manual checks automation cannot cover:

- [ ] The install prompt actually appears in Chrome on the LAN address, and the installed icon is the brand icon rather than a screenshot of the page.
- [ ] On iOS, Share → Add to Home Screen produces the right icon and opens without Safari chrome.
- [ ] Turning the phone's Wi-Fi off and opening the installed app shows the unreachable screen, not a browser error — the whole point of the feature.
- [ ] Retry from that screen, once back on the network, lands on the portal without a manual reload.
