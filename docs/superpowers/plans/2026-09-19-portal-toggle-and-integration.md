# Portal Toggle and Home Assistant Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted enable/disable kill-switch for the guest surface, and a Home Assistant custom integration that exposes it as a switch alongside a timestamp sensor reporting the last guest interaction.

**Architecture:** The toggle's truth lives in the add-on's SQLite so the portal never depends on Home Assistant being reachable. A new bearer-token-authenticated route pair (`/api/integration/*`) is the only surface the integration touches. In add-on deployments the add-on announces itself to the Supervisor, which opens a config flow on the custom integration; plain Docker deployments use a manual config flow with a token copied from the admin UI.

**Tech Stack:** TypeScript / Node 24 / Hono / `node:sqlite` / Zod 4 / React 19 / vitest / Playwright on the add-on side. Python / Home Assistant 2026.9 / pytest / `pytest-homeassistant-custom-component` / ruff / uv on the integration side.

**Spec:** `docs/superpowers/specs/2026-09-19-portal-toggle-and-integration-design.md`

## Global Constraints

- **Node >= 24.** Only the `prepare`/`run`/`get`/`all` subset of `node:sqlite` may be used.
- **`@types/node` stays on the `^24` line.** Do not upgrade it.
- **Never destroy or weaken `action_log`.** It is a security artifact. This plan adds tables; it alters none.
- **The HA token never reaches a browser.** No new route may return it.
- **All new gates key on `role === 'guest'`.** Admin-role requests and all ingress-sourced requests must be unaffected by the kill-switch.
- **No `Secure` flag on cookies.** This is plain HTTP on LAN; adding it silently breaks login.
- **Imports inside `src/` use `.js` extensions**; imports inside `test/` use `.ts` extensions. Match the file you are editing.
- **Formatting:** run `pnpm lint` and `pnpm format` before each commit. Biome, 2-space indent, single quotes, no semicolons.
- **Typecheck:** `pnpm typecheck` must pass before every commit. It runs three tsconfigs; all three must be clean.
- **Python pins:** `pytest-homeassistant-custom-component==0.13.366`, `ruff==0.16.8`. That harness pins Home Assistant 2026.9.x transitively — do not pin `homeassistant` yourself.
- **Integration domain is `ha_guest_portal`** everywhere: the add-on's discovery `service`, the directory name, and `manifest.json:domain`. These three must match exactly or discovery silently does nothing.
- **Commit after every task.** Never use `Co-Authored-By` trailers or AI-attribution footers.

---

## File Structure

**Created — add-on:**

| File | Responsibility |
|---|---|
| `src/server/store/settings.ts` | `SettingsStore`: key/value settings, the enabled flag and its change listeners, lazily-generated token and portal id |
| `src/server/store/interactions.ts` | `InteractionStore`: the single-row latest-guest-interaction record |
| `src/server/http/routes-integration.ts` | Bearer-authenticated integration route pair |
| `src/server/hassio/discovery.ts` | Supervisor discovery publication |
| `src/web/routes/PortalDisabled.tsx` | The screen a guest sees while the portal is off |
| `src/web/components/PortalToggle.tsx` | Admin toggle + integration token display |
| `test/fake-supervisor.ts` | Fake Supervisor HTTP server for discovery tests |

**Created — integration:**

`custom_components/ha_guest_portal/{__init__,const,api,coordinator,config_flow,switch,sensor}.py`, `manifest.json`, `strings.json`, `translations/en.json`; `hacs.json`, `brand/icon.png`, `pyproject.toml`, `tests/` for the Python side.

**Modified — add-on:** `src/server/store/db.ts` (schema), `src/shared/api.ts` (schemas), `src/server/http/sse.ts` (per-connection role), `src/server/http/routes-guest.ts` (gates + recording), `src/server/http/routes-admin.ts` (portal routes), `src/server/app.ts` (mount), `src/server/runtime.ts` (stream gate, deps, broadcast), `src/server/index.ts` (construction, discovery), `src/web/{api,store}.ts`, `src/web/App.tsx`, `src/web/routes/Admin.tsx`, `config.yaml`, `.dockerignore`, `biome.json`, `README.md`, `DOCS.md`, `docs/DECISIONS.md`.

---

## Phase 1 — Persistence and the kill-switch

### Task 1: SettingsStore

**Files:**
- Create: `src/server/store/settings.ts`
- Modify: `src/server/store/db.ts:7-23` (add table to `SCHEMA`)
- Modify: `src/server/http/routes-guest.ts:20-28` (`Deps` type), `src/server/runtime.ts:22-30` (`Deps` type), `src/server/index.ts:17-27` (construction)
- Modify: `test/integration/routes-guest.test.ts`, `test/integration/routes-admin.test.ts`, `test/integration/ingress-security.test.ts`, `test/integration/server-process.test.ts` (add `settings` to every `createRuntime` call)
- Test: `test/unit/settings.test.ts`

**Interfaces:**
- Consumes: `openDb` from `src/server/store/db.ts`.
- Produces:
  ```ts
  export type PortalEnabledListener = (enabled: boolean) => void
  export class SettingsStore {
    constructor(db: DatabaseSync)
    getPortalEnabled(): boolean
    setPortalEnabled(enabled: boolean): void
    onPortalEnabledChange(fn: PortalEnabledListener): () => void
    getIntegrationToken(): string
    getPortalId(): string
  }
  ```
  `Deps` (in both `routes-guest.ts` and `runtime.ts`) gains `settings: SettingsStore`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/settings.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../src/server/store/db.ts'
import { SettingsStore } from '../../src/server/store/settings.ts'

describe('SettingsStore', () => {
  let db: DatabaseSync
  let settings: SettingsStore

  beforeEach(() => {
    db = openDb(':memory:')
    settings = new SettingsStore(db)
  })

  it('defaults to enabled', () => {
    expect(settings.getPortalEnabled()).toBe(true)
  })

  it('persists a disabled flag across store instances', () => {
    settings.setPortalEnabled(false)
    expect(new SettingsStore(db).getPortalEnabled()).toBe(false)
  })

  it('notifies listeners on change', () => {
    const listener = vi.fn()
    settings.onPortalEnabledChange(listener)

    settings.setPortalEnabled(false)

    expect(listener).toHaveBeenCalledWith(false)
  })

  it('does not notify listeners when the value is unchanged', () => {
    const listener = vi.fn()
    settings.onPortalEnabledChange(listener)

    settings.setPortalEnabled(true)

    expect(listener).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = settings.onPortalEnabledChange(listener)
    unsubscribe()

    settings.setPortalEnabled(false)

    expect(listener).not.toHaveBeenCalled()
  })

  it('generates a stable integration token', () => {
    const token = settings.getIntegrationToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(settings.getIntegrationToken()).toBe(token)
    expect(new SettingsStore(db).getIntegrationToken()).toBe(token)
  })

  it('generates a stable portal id', () => {
    const id = settings.getPortalId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(new SettingsStore(db).getPortalId()).toBe(id)
  })

  it('generates a different token for a different database', () => {
    const other = new SettingsStore(openDb(':memory:'))
    expect(other.getIntegrationToken()).not.toBe(settings.getIntegrationToken())
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/unit/settings.test.ts`
Expected: FAIL — cannot resolve `../../src/server/store/settings.ts`.

- [ ] **Step 3: Add the settings table to the schema**

In `src/server/store/db.ts`, append to the `SCHEMA` template literal, after the `action_log` block:

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 4: Write the SettingsStore**

Create `src/server/store/settings.ts`:

```ts
// src/server/store/settings.ts
import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export type PortalEnabledListener = (enabled: boolean) => void

const KEY_PORTAL_ENABLED = 'portal_enabled'
const KEY_INTEGRATION_TOKEN = 'integration_token'
const KEY_PORTAL_ID = 'portal_id'

const SettingRowSchema = z.object({
  value: z.string(),
})

export class SettingsStore {
  private db: DatabaseSync
  private listeners: Set<PortalEnabledListener> = new Set()

  constructor(db: DatabaseSync) {
    this.db = db
  }

  private read(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    if (row === undefined) return null

    const parsed = SettingRowSchema.safeParse(row)
    return parsed.success ? parsed.data.value : null
  }

  private write(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }

  /**
   * Read a value, generating and persisting one on first access.
   * Used for the integration token and portal id, which must be stable
   * for the life of the database but are never configured by hand.
   */
  private readOrCreate(key: string, generate: () => string): string {
    const existing = this.read(key)
    if (existing !== null) return existing

    const created = generate()
    this.write(key, created)
    return created
  }

  getPortalEnabled(): boolean {
    // Absent means enabled: an existing installation that upgrades into this
    // feature must not have its guest portal silently switched off.
    return this.read(KEY_PORTAL_ENABLED) !== '0'
  }

  setPortalEnabled(enabled: boolean): void {
    if (this.getPortalEnabled() === enabled) return

    this.write(KEY_PORTAL_ENABLED, enabled ? '1' : '0')

    for (const listener of this.listeners) {
      listener(enabled)
    }
  }

  onPortalEnabledChange(fn: PortalEnabledListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getIntegrationToken(): string {
    return this.readOrCreate(KEY_INTEGRATION_TOKEN, () => randomBytes(32).toString('hex'))
  }

  getPortalId(): string {
    return this.readOrCreate(KEY_PORTAL_ID, () => randomUUID())
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/settings.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Thread `settings` through Deps**

In `src/server/http/routes-guest.ts`, add the import and the field:

```ts
import type { SettingsStore } from '../store/settings.js'
```

```ts
export type Deps = {
  cfg: Config
  ha: HaClient
  allowlist: AllowlistStore
  audit: AuditLog
  settings: SettingsStore
  sessions: SessionStore
  limiter: LoginRateLimiter
  hub: SseHub
}
```

Make the identical addition to the `Deps` type in `src/server/runtime.ts:22-30` (same import path, but `./store/settings.js`).

In `src/server/index.ts`, import `SettingsStore` from `./store/settings.js`, construct it next to `audit`:

```ts
const settings = new SettingsStore(db)
```

and add `settings,` to the object passed to `createRuntime`.

- [ ] **Step 7: Fix the four integration test files**

Each of `test/integration/routes-guest.test.ts`, `test/integration/routes-admin.test.ts`, `test/integration/ingress-security.test.ts`, and `test/integration/server-process.test.ts` constructs `createRuntime({...})`. In each: add the import

```ts
import { SettingsStore } from '../../src/server/store/settings.ts'
```

declare `let settings: SettingsStore` beside the other `let` declarations, construct `settings = new SettingsStore(db)` immediately after the `AuditLog` construction, and add `settings,` to the `createRuntime` argument object.

- [ ] **Step 8: Verify the whole suite and typecheck**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS. If a test file reports "Property 'settings' is missing", one of the four call sites was missed.

- [ ] **Step 9: Commit**

```bash
git add src/server/store/settings.ts src/server/store/db.ts src/server/http/routes-guest.ts src/server/runtime.ts src/server/index.ts test/unit/settings.test.ts test/integration
git commit -m "feat: add SettingsStore for portal enablement, token, and portal id"
```

---

### Task 2: InteractionStore

**Files:**
- Create: `src/server/store/interactions.ts`
- Modify: `src/server/store/db.ts` (add table to `SCHEMA`)
- Modify: `src/server/http/routes-guest.ts` (`Deps`), `src/server/runtime.ts` (`Deps`), `src/server/index.ts` (construction)
- Modify: the same four integration test files as Task 1
- Test: `test/unit/interactions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GuestInteraction = {
    ts: number
    kind: 'action' | 'login'
    entityId: string | null
    label: string | null
    action: string | null
    ok: boolean
  }
  export class InteractionStore {
    constructor(db: DatabaseSync)
    record(e: GuestInteraction): void
    latest(): GuestInteraction | null
  }
  ```
  `Deps` gains `interactions: InteractionStore`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/interactions.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../src/server/store/db.ts'
import { InteractionStore } from '../../src/server/store/interactions.ts'

describe('InteractionStore', () => {
  let db: DatabaseSync
  let store: InteractionStore

  beforeEach(() => {
    db = openDb(':memory:')
    store = new InteractionStore(db)
  })

  it('returns null before any interaction', () => {
    expect(store.latest()).toBeNull()
  })

  it('round-trips an action interaction', () => {
    store.record({
      ts: 1_700_000_000_000,
      kind: 'action',
      entityId: 'lock.front',
      label: 'Front Door',
      action: 'unlock',
      ok: true,
    })

    expect(store.latest()).toEqual({
      ts: 1_700_000_000_000,
      kind: 'action',
      entityId: 'lock.front',
      label: 'Front Door',
      action: 'unlock',
      ok: true,
    })
  })

  it('round-trips a login interaction with null device columns', () => {
    store.record({
      ts: 1_700_000_000_001,
      kind: 'login',
      entityId: null,
      label: null,
      action: null,
      ok: true,
    })

    expect(store.latest()).toEqual({
      ts: 1_700_000_000_001,
      kind: 'login',
      entityId: null,
      label: null,
      action: null,
      ok: true,
    })
  })

  it('keeps only the most recent interaction', () => {
    store.record({
      ts: 1, kind: 'login', entityId: null, label: null, action: null, ok: true,
    })
    store.record({
      ts: 2, kind: 'action', entityId: 'light.porch', label: 'Porch', action: 'turn_on', ok: false,
    })

    expect(store.latest()?.ts).toBe(2)

    const count = db.prepare('SELECT COUNT(*) AS n FROM guest_interaction').get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('persists across store instances', () => {
    store.record({
      ts: 42, kind: 'login', entityId: null, label: null, action: null, ok: true,
    })

    expect(new InteractionStore(db).latest()?.ts).toBe(42)
  })

  it('records a failed action', () => {
    store.record({
      ts: 7, kind: 'action', entityId: 'lock.back', label: 'Back Door', action: 'unlock', ok: false,
    })

    expect(store.latest()?.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/unit/interactions.test.ts`
Expected: FAIL — cannot resolve `interactions.ts`.

- [ ] **Step 3: Add the table to the schema**

Append to `SCHEMA` in `src/server/store/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS guest_interaction (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  ts        INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  entity_id TEXT,
  label     TEXT,
  action    TEXT,
  ok        INTEGER NOT NULL
);
```

- [ ] **Step 4: Write the InteractionStore**

Create `src/server/store/interactions.ts`:

```ts
// src/server/store/interactions.ts
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export type GuestInteraction = {
  ts: number
  kind: 'action' | 'login'
  entityId: string | null
  label: string | null
  action: string | null
  ok: boolean
}

const InteractionRowSchema = z.object({
  ts: z.number(),
  kind: z.enum(['action', 'login']),
  entity_id: z.string().nullable(),
  label: z.string().nullable(),
  action: z.string().nullable(),
  ok: z.number(),
})

/**
 * Holds only the most recent guest interaction, upserted on id = 1.
 *
 * Home Assistant's recorder keeps the state history of the sensor fed by this
 * row, so a second history here would be redundant. It is persisted rather
 * than held in memory so the sensor does not blank to `unknown` on restart.
 */
export class InteractionStore {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  record(e: GuestInteraction): void {
    this.db
      .prepare(
        `INSERT INTO guest_interaction (id, ts, kind, entity_id, label, action, ok)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ts = excluded.ts,
           kind = excluded.kind,
           entity_id = excluded.entity_id,
           label = excluded.label,
           action = excluded.action,
           ok = excluded.ok`,
      )
      .run(e.ts, e.kind, e.entityId, e.label, e.action, e.ok ? 1 : 0)
  }

  latest(): GuestInteraction | null {
    const row = this.db
      .prepare('SELECT ts, kind, entity_id, label, action, ok FROM guest_interaction WHERE id = 1')
      .get()

    if (row === undefined) return null

    const parsed = InteractionRowSchema.safeParse(row)
    if (!parsed.success) return null

    const { ts, kind, entity_id, label, action, ok } = parsed.data

    return {
      ts,
      kind,
      entityId: entity_id,
      label,
      action,
      ok: ok === 1,
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/interactions.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Thread `interactions` through Deps**

Exactly as Task 1 Step 6, for `interactions: InteractionStore`: add to the `Deps` type in both `src/server/http/routes-guest.ts` and `src/server/runtime.ts`, construct in `src/server/index.ts` as `const interactions = new InteractionStore(db)`, and pass `interactions,` to `createRuntime`.

- [ ] **Step 7: Fix the four integration test files**

As Task 1 Step 7, adding `interactions = new InteractionStore(db)` and `interactions,` to each `createRuntime` call.

- [ ] **Step 8: Verify**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server/store/interactions.ts src/server/store/db.ts src/server/http/routes-guest.ts src/server/runtime.ts src/server/index.ts test/unit/interactions.test.ts test/integration
git commit -m "feat: add InteractionStore recording the latest guest interaction"
```

---

### Task 3: Shared API schemas

**Files:**
- Modify: `src/shared/api.ts`
- Test: `test/unit/api-schemas.test.ts` (append)

**Interfaces:**
- Produces, all exported from `src/shared/api.ts`:
  ```ts
  export const SessionResponse: z.ZodObject   // now { role, portalEnabled }
  export const AdminPortalResponse: z.ZodObject     // { enabled, integrationToken, portalId }
  export const AdminPortalPutRequest: z.ZodObject   // { enabled }
  export const IntegrationStateResponse: z.ZodObject
  export const IntegrationEnabledRequest: z.ZodObject // { enabled }
  export type SseFrame                        // gains { type: 'portal', enabled }
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/unit/api-schemas.test.ts`:

```ts
describe('portal toggle schemas', () => {
  it('requires portalEnabled on SessionResponse', () => {
    expect(SessionResponse.safeParse({ role: 'guest' }).success).toBe(false)
    expect(SessionResponse.parse({ role: 'guest', portalEnabled: false })).toEqual({
      role: 'guest',
      portalEnabled: false,
    })
  })

  it('accepts a portal SSE frame', () => {
    expect(SseFrameSchema.parse({ type: 'portal', enabled: false })).toEqual({
      type: 'portal',
      enabled: false,
    })
  })

  it('rejects a portal frame without enabled', () => {
    expect(SseFrameSchema.safeParse({ type: 'portal' }).success).toBe(false)
  })

  it('parses an admin portal response', () => {
    expect(
      AdminPortalResponse.parse({
        enabled: true,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
      }).enabled,
    ).toBe(true)
  })

  it('rejects a non-boolean enabled on the put request', () => {
    expect(AdminPortalPutRequest.safeParse({ enabled: 'yes' }).success).toBe(false)
  })

  it('parses an integration state response with a null interaction', () => {
    const parsed = IntegrationStateResponse.parse({
      portalId: '11111111-1111-1111-1111-111111111111',
      enabled: true,
      haStale: false,
      deviceCount: 3,
      version: '0.2.0',
      lastInteraction: null,
    })
    expect(parsed.lastInteraction).toBeNull()
  })

  it('parses an integration state response with an action interaction', () => {
    const parsed = IntegrationStateResponse.parse({
      portalId: '11111111-1111-1111-1111-111111111111',
      enabled: false,
      haStale: true,
      deviceCount: 0,
      version: '0.2.0',
      lastInteraction: {
        ts: 1,
        kind: 'action',
        entityId: 'lock.front',
        label: 'Front Door',
        action: 'unlock',
        ok: true,
      },
    })
    expect(parsed.lastInteraction?.kind).toBe('action')
  })
})
```

Add `AdminPortalResponse`, `AdminPortalPutRequest`, `IntegrationStateResponse`, `SseFrameSchema`, and `SessionResponse` to the file's existing import from `@shared/api.js` (or `../../src/shared/api.ts`, whichever that file already uses).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/unit/api-schemas.test.ts`
Expected: FAIL — `AdminPortalResponse` is not exported.

- [ ] **Step 3: Update SessionResponse**

In `src/shared/api.ts`, replace the `SessionResponse` definition:

```ts
export const SessionResponse = z.object({
  role: RoleSchema,
  portalEnabled: z.boolean(),
})
```

- [ ] **Step 4: Add the portal SSE frame**

Add above the `SseFrameSchema` union:

```ts
const PortalFrameSchema = z.object({
  type: z.literal('portal'),
  enabled: z.boolean(),
})
```

and add `PortalFrameSchema` as a fourth member of the `z.discriminatedUnion('type', [...])`.

- [ ] **Step 5: Add the portal and integration schemas**

Append to `src/shared/api.ts`:

```ts
// Portal toggle schemas
export const AdminPortalResponse = z.object({
  enabled: z.boolean(),
  integrationToken: z.string(),
  portalId: z.string(),
})

export const AdminPortalPutRequest = z.object({
  enabled: z.boolean(),
})

const InteractionSchema = z.object({
  ts: z.number(),
  kind: z.enum(['action', 'login']),
  entityId: z.string().nullable(),
  label: z.string().nullable(),
  action: z.string().nullable(),
  ok: z.boolean(),
})

export const IntegrationStateResponse = z.object({
  portalId: z.string(),
  enabled: z.boolean(),
  haStale: z.boolean(),
  deviceCount: z.number(),
  version: z.string(),
  lastInteraction: InteractionSchema.nullable(),
})

export const IntegrationEnabledRequest = z.object({
  enabled: z.boolean(),
})
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/api-schemas.test.ts`
Expected: PASS.

- [ ] **Step 7: Fix the now-broken SessionResponse call sites**

`pnpm typecheck` will fail: `SessionResponse.parse({ role })` in `src/server/http/routes-guest.ts` (two places: `login` and `session`) no longer satisfies the schema. For now, pass the literal `portalEnabled: true` at both call sites — Task 5 replaces it with the real value.

Also update `src/web/api.ts`: `getSession()` returns `Promise<{ role: Role } | null>`; widen the return type to `Promise<{ role: Role; portalEnabled: boolean } | null>`, and `login()`'s result type to `ApiResult<{ role: Role; portalEnabled: boolean }>`.

- [ ] **Step 8: Verify**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/shared/api.ts src/server/http/routes-guest.ts src/web/api.ts test/unit/api-schemas.test.ts
git commit -m "feat: add portal toggle and integration API schemas"
```

---

### Task 4: Per-connection roles in SseHub

**Files:**
- Modify: `src/server/http/sse.ts`
- Modify: `src/server/runtime.ts:155` and `:205` (the two `hub.add(res)` call sites)
- Test: `test/unit/sse.test.ts` (append)

**Interfaces:**
- Consumes: `Role` from `src/shared/api.ts`.
- Produces: `add(res: ServerResponse, role: Role): () => void` — the `role` parameter is now **required**; `closeRole(role: Role): void`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/sse.test.ts`. Use whatever fake-response helper that file already defines; if it builds `ServerResponse` objects inline, follow the same shape.

```ts
describe('closeRole', () => {
  it('closes only connections with the named role', () => {
    const hub = new SseHub()
    const guest = makeFakeResponse()
    const admin = makeFakeResponse()

    hub.add(guest, 'guest')
    hub.add(admin, 'admin')
    expect(hub.clientCount).toBe(2)

    hub.closeRole('guest')

    expect(hub.clientCount).toBe(1)
    expect(guest.writableEnded).toBe(true)
    expect(admin.writableEnded).toBe(false)
  })

  it('still broadcasts to the surviving role', () => {
    const hub = new SseHub()
    const guest = makeFakeResponse()
    const admin = makeFakeResponse()
    hub.add(guest, 'guest')
    hub.add(admin, 'admin')

    hub.closeRole('guest')
    hub.broadcast({ type: 'portal', enabled: false })

    expect(admin.written.join('')).toContain('"type":"portal"')
  })

  it('is a no-op when no connection has that role', () => {
    const hub = new SseHub()
    hub.add(makeFakeResponse(), 'admin')

    expect(() => hub.closeRole('guest')).not.toThrow()
    expect(hub.clientCount).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/unit/sse.test.ts`
Expected: FAIL — `hub.closeRole is not a function`.

- [ ] **Step 3: Change the client set to a map**

In `src/server/http/sse.ts`, import `Role`:

```ts
import type { Role, SseFrame } from '../../shared/api.js'
```

Replace the field:

```ts
  private readonly clients = new Map<ServerResponse, Role>()
```

`Map` iteration in the existing `broadcast`, `close`, and `startHeartbeat` loops must now iterate keys. Change each `for (const client of this.clients)` to `for (const client of this.clients.keys())`. `this.clients.delete(client)`, `this.clients.add(...)` → `this.clients.set(...)`, `this.clients.has(...)`, `this.clients.size`, and `this.clients.clear()` all keep working unchanged apart from `add` → `set`.

- [ ] **Step 4: Take the role in `add` and implement `closeRole`**

Change the signature and the insertion:

```ts
  add(res: ServerResponse, role: Role): () => void {
```

```ts
    // Add to clients
    this.clients.set(res, role)
```

Add the new method after `broadcast`:

```ts
  /**
   * End every stream held by the named role, leaving others connected.
   * Used by the kill-switch: disabling the portal must drop guest streams
   * without disturbing an admin watching the same hub over ingress.
   */
  closeRole(role: Role): void {
    for (const [client, clientRole] of this.clients) {
      if (clientRole !== role) continue

      this.clients.delete(client)

      try {
        if (!client.writableEnded) {
          client.end()
        }
      } catch {
        // Already torn down; nothing to clean up.
      }
    }

    if (this.clients.size === 0) {
      this.stopHeartbeat()
    }
  }
```

- [ ] **Step 5: Update the two call sites**

In `src/server/runtime.ts`, `handleDirectRequest` calls `hub.add(res)` at line ~155 inside the block that has already resolved `role` — change it to `hub.add(res, role)`.

`handleIngressRequest` calls `hub.add(res)` at line ~205; ingress is always admin, so change it to `hub.add(res, 'admin')`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS. The compiler will point at any `hub.add` call missing its role argument.

- [ ] **Step 7: Commit**

```bash
git add src/server/http/sse.ts src/server/runtime.ts test/unit/sse.test.ts
git commit -m "feat: track a role per SSE connection and add closeRole"
```

---

### Task 5: Kill-switch enforcement

**Files:**
- Modify: `src/server/http/routes-guest.ts` (login, session, devices, callAction)
- Modify: `src/server/runtime.ts` (stream gate, settings change wiring)
- Test: `test/integration/portal-toggle.test.ts` (create)

**Interfaces:**
- Consumes: `SettingsStore` (Task 1), `SseHub.closeRole` (Task 4), `SessionResponse` with `portalEnabled` (Task 3).
- Produces: `403 {error:'portal_disabled'}` on the four guest surfaces; `{type:'portal', enabled}` broadcast on change.

- [ ] **Step 1: Write the failing test**

Create `test/integration/portal-toggle.test.ts`. Copy the `beforeEach`/`afterEach` scaffolding verbatim from `test/integration/routes-guest.test.ts` (fake HA, in-memory db, allowlist seed, `createRuntime`, `server.listen(0)`, `baseUrl`), including the `settings` and `interactions` construction added in Tasks 1–2, then:

```ts
  async function loginAs(password: string): Promise<{ status: number; cookie: string }> {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    return { status: res.status, cookie: res.headers.get('set-cookie') ?? '' }
  }

  it('refuses guest login while disabled', async () => {
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'guest-password' }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'portal_disabled' })
  })

  it('does not count a blocked guest login against the rate limiter', async () => {
    settings.setPortalEnabled(false)

    for (let i = 0; i < 15; i++) {
      await loginAs('guest-password')
    }

    settings.setPortalEnabled(true)
    const { status } = await loginAs('guest-password')

    expect(status).toBe(200)
  })

  it('still allows admin login while disabled', async () => {
    settings.setPortalEnabled(false)
    const { status } = await loginAs('admin-password')
    expect(status).toBe(200)
  })

  it('reports portalEnabled on the session route', async () => {
    const { cookie } = await loginAs('guest-password')
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/session`, { headers: { cookie } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ role: 'guest', portalEnabled: false })
  })

  it('refuses an existing guest session on /api/devices while disabled', async () => {
    const { cookie } = await loginAs('guest-password')
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/devices`, { headers: { cookie } })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'portal_disabled' })
  })

  it('refuses a guest action while disabled', async () => {
    const { cookie } = await loginAs('guest-password')
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/devices/light.porch/turn_on`, {
      method: 'POST',
      headers: { cookie },
    })

    expect(res.status).toBe(403)
  })

  it('refuses a guest stream while disabled', async () => {
    const { cookie } = await loginAs('guest-password')
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/stream`, { headers: { cookie } })

    expect(res.status).toBe(403)
    await res.body?.cancel()
  })

  it('leaves admin device access working while disabled', async () => {
    const { cookie } = await loginAs('admin-password')
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/devices`, { headers: { cookie } })

    expect(res.status).toBe(200)
  })

  it('restores guest access when re-enabled, without a new login', async () => {
    const { cookie } = await loginAs('guest-password')
    settings.setPortalEnabled(false)
    settings.setPortalEnabled(true)

    const res = await fetch(`${baseUrl}/api/devices`, { headers: { cookie } })

    expect(res.status).toBe(200)
  })

  it('closes guest streams but not admin streams when disabled', async () => {
    const guest = await loginAs('guest-password')
    const admin = await loginAs('admin-password')

    const guestStream = await fetch(`${baseUrl}/api/stream`, { headers: { cookie: guest.cookie } })
    const adminStream = await fetch(`${baseUrl}/api/stream`, { headers: { cookie: admin.cookie } })
    expect(guestStream.status).toBe(200)
    expect(adminStream.status).toBe(200)

    settings.setPortalEnabled(false)

    // The guest stream ends; reading it to completion must terminate.
    const guestReader = guestStream.body!.getReader()
    let guestClosed = false
    for (let i = 0; i < 20; i++) {
      const { done } = await guestReader.read()
      if (done) {
        guestClosed = true
        break
      }
    }
    expect(guestClosed).toBe(true)

    await adminStream.body?.cancel()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/integration/portal-toggle.test.ts`
Expected: FAIL — guest login returns 200 rather than 403.

- [ ] **Step 3: Gate the login route**

In `src/server/http/routes-guest.ts`, destructure `settings` from `deps`:

```ts
  const { cfg, ha, allowlist, audit, settings, sessions, limiter } = deps
```

In `login`, immediately after `const role = classify(password, cfg)` and the `role === null` branch, insert:

```ts
      // Portal disabled: block guests, leave admins alone.
      // Deliberately does NOT call limiter.recordFailure() — the password was
      // correct, and counting it would let a disabled portal lock out a guest
      // who keeps retrying, leaving them locked out after re-enabling.
      if (role === 'guest' && !settings.getPortalEnabled()) {
        return c.json({ error: 'portal_disabled' }, 403)
      }
```

Then change the two `SessionResponse.parse({ role })` calls (in `login` and `session`) to:

```ts
SessionResponse.parse({ role, portalEnabled: settings.getPortalEnabled() })
```

- [ ] **Step 4: Gate devices and callAction**

Add this helper inside `createRoutes`, above the returned object:

```ts
  function portalBlocked(role: Role): boolean {
    return role === 'guest' && !settings.getPortalEnabled()
  }
```

`Role` is already imported in this file via `../../shared/api.js`; if not, add it to that import.

In `devices`, after the `if (!role)` guard:

```ts
      if (portalBlocked(role)) {
        return c.json({ error: 'portal_disabled' }, 403)
      }
```

Add the identical block to `callAction`, after its `if (!role)` guard and **before** the `entityId`/`action` parameter reads. A blocked request must not reach `validateAction` or write an `action_log` row: the portal is off, so there is no boundary probe to record.

- [ ] **Step 5: Gate the SSE stream and broadcast on change**

In `src/server/runtime.ts`, destructure `settings` in `createRuntime`:

```ts
  const { ha, allowlist, hub, sessions, settings } = deps
```

In `handleDirectRequest`, inside the `/api/stream` branch, after the `if (!role)` 401 block:

```ts
      if (role === 'guest' && !settings.getPortalEnabled()) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'portal_disabled' }))
        return
      }
```

The ingress handler needs no gate: ingress is admin-only by construction.

Then wire the change listener, next to the existing `allowlist.onChange` wiring:

```ts
  // Wire settings.onPortalEnabledChange → broadcast + drop guest streams
  settings.onPortalEnabledChange((enabled) => {
    const frame: SseFrame = SseFrameSchema.parse({ type: 'portal', enabled })
    hub.broadcast(frame)

    // Broadcast first, then drop: a guest that receives the frame switches to
    // the disabled screen immediately. Closing the stream is the fallback —
    // the client's existing stream-drop recheck hits /api/session and lands on
    // the same screen even if the frame was missed.
    if (!enabled) {
      hub.closeRole('guest')
    }
  })
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run test/integration/portal-toggle.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Verify nothing else regressed**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS. Tests asserting `{ role: 'guest' }` from `/api/session` in `routes-guest.test.ts` will now fail — update those assertions to include `portalEnabled: true`.

- [ ] **Step 8: Commit**

```bash
git add src/server/http/routes-guest.ts src/server/runtime.ts test/integration
git commit -m "feat: block guests when the portal is disabled"
```

---

### Task 6: Record guest interactions

**Files:**
- Modify: `src/server/http/routes-guest.ts` (login, callAction)
- Test: `test/integration/portal-toggle.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `InteractionStore` (Task 2).
- Produces: a `guest_interaction` row on guest login and every guest action attempt.

- [ ] **Step 1: Write the failing test**

Append to `test/integration/portal-toggle.test.ts`:

```ts
  describe('interaction recording', () => {
    it('records a guest login', async () => {
      await loginAs('guest-password')

      const latest = interactions.latest()
      expect(latest?.kind).toBe('login')
      expect(latest?.ok).toBe(true)
      expect(latest?.entityId).toBeNull()
    })

    it('does not record an admin login', async () => {
      await loginAs('admin-password')
      expect(interactions.latest()).toBeNull()
    })

    it('records a successful guest action with its label', async () => {
      const { cookie } = await loginAs('guest-password')

      await fetch(`${baseUrl}/api/devices/light.porch/turn_on`, {
        method: 'POST',
        headers: { cookie },
      })

      expect(interactions.latest()).toMatchObject({
        kind: 'action',
        entityId: 'light.porch',
        label: 'Porch',
        action: 'turn_on',
        ok: true,
      })
    })

    it('records a rejected guest action', async () => {
      const { cookie } = await loginAs('guest-password')

      await fetch(`${baseUrl}/api/devices/light.not_allowlisted/turn_on`, {
        method: 'POST',
        headers: { cookie },
      })

      expect(interactions.latest()).toMatchObject({
        kind: 'action',
        entityId: 'light.not_allowlisted',
        action: 'turn_on',
        ok: false,
      })
    })

    it('leaves label null for an action on an unknown entity', async () => {
      const { cookie } = await loginAs('guest-password')

      await fetch(`${baseUrl}/api/devices/light.not_allowlisted/turn_on`, {
        method: 'POST',
        headers: { cookie },
      })

      expect(interactions.latest()?.label).toBeNull()
    })

    it('does not record an admin action', async () => {
      const { cookie } = await loginAs('admin-password')

      await fetch(`${baseUrl}/api/devices/light.porch/turn_on`, {
        method: 'POST',
        headers: { cookie },
      })

      expect(interactions.latest()).toBeNull()
    })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/integration/portal-toggle.test.ts -t "interaction recording"`
Expected: FAIL — `interactions.latest()` is null after a guest login.

- [ ] **Step 3: Record guest logins**

Destructure `interactions` in `createRoutes`:

```ts
  const { cfg, ha, allowlist, audit, settings, interactions, sessions, limiter } = deps
```

In `login`, after `limiter.recordSuccess(ip)` and before `sessions.create(role)`:

```ts
      if (role === 'guest') {
        interactions.record({
          ts: Date.now(),
          kind: 'login',
          entityId: null,
          label: null,
          action: null,
          ok: true,
        })
      }
```

- [ ] **Step 4: Record guest actions**

In `callAction`, the validation-failure branch already computes `ts`. Add the recording alongside the existing `audit.record` call in **both** branches.

In the `if (!validation.ok)` branch, after `audit.record({...})`:

```ts
        if (role === 'guest') {
          interactions.record({
            ts,
            kind: 'action',
            entityId,
            label: allowlist.asMap().get(entityId)?.label ?? null,
            action,
            ok: false,
          })
        }
```

And after the success-path `audit.record({...})`:

```ts
      if (role === 'guest') {
        interactions.record({
          ts,
          kind: 'action',
          entityId,
          label: allowlist.asMap().get(entityId)?.label ?? null,
          action,
          ok: result.ok,
        })
      }
```

The label is read from the allowlist at write time so the sensor attribute stays human-readable after the device is removed. `asMap()` returns rows keyed by entity id; a rejected action on an unknown entity yields `null`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/integration/portal-toggle.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 6: Confirm the allowlist row shape**

Run: `grep -n "asMap" src/server/store/allowlist.ts`
Expected: a method returning a map whose values carry a `label`. If the value type has no `label` field, use `allowlist.list().find((d) => d.entityId === entityId)?.label ?? null` instead.

- [ ] **Step 7: Verify and commit**

Run: `pnpm typecheck && pnpm vitest run`

```bash
git add src/server/http/routes-guest.ts test/integration/portal-toggle.test.ts
git commit -m "feat: record guest logins and actions as portal interactions"
```

---

### Task 7: Admin portal routes

**Files:**
- Modify: `src/server/http/routes-admin.ts`
- Test: `test/integration/routes-admin.test.ts` (append)

**Interfaces:**
- Produces: `GET /api/admin/portal` → `{enabled, integrationToken, portalId}`; `PUT /api/admin/portal` `{enabled}` → `{enabled}`.

- [ ] **Step 1: Write the failing test**

Append to `test/integration/routes-admin.test.ts`:

```ts
  describe('portal toggle routes', () => {
    it('returns portal state, token, and id to an admin', async () => {
      const res = await fetch(`${baseUrl}/api/admin/portal`, {
        headers: { cookie: adminCookie },
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.enabled).toBe(true)
      expect(body.integrationToken).toMatch(/^[0-9a-f]{64}$/)
      expect(body.portalId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('refuses a guest', async () => {
      const res = await fetch(`${baseUrl}/api/admin/portal`, {
        headers: { cookie: guestCookie },
      })
      expect(res.status).toBe(403)
    })

    it('refuses an anonymous request', async () => {
      const res = await fetch(`${baseUrl}/api/admin/portal`)
      expect(res.status).toBe(401)
    })

    it('disables the portal', async () => {
      const res = await fetch(`${baseUrl}/api/admin/portal`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ enabled: false }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ enabled: false })
      expect(settings.getPortalEnabled()).toBe(false)
    })

    it('rejects a non-boolean enabled', async () => {
      const res = await fetch(`${baseUrl}/api/admin/portal`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ enabled: 'nope' }),
      })

      expect(res.status).toBe(400)
      expect(settings.getPortalEnabled()).toBe(true)
    })

    it('rejects malformed JSON', async () => {
      const res = await fetch(`${baseUrl}/api/admin/portal`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie: adminCookie },
        body: 'not json',
      })

      expect(res.status).toBe(400)
    })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/integration/routes-admin.test.ts -t "portal toggle routes"`
Expected: FAIL — 404 on `/api/admin/portal`.

- [ ] **Step 3: Implement the routes**

In `src/server/http/routes-admin.ts`, extend the import and destructuring:

```ts
import {
  AdminPortalPutRequest,
  AdminPortalResponse,
  AllowlistPutRequest,
  AllowlistResponse,
  CatalogResponse,
} from '../../shared/api.js'
```

```ts
  const { ha, allowlist, settings } = deps
```

Append inside `mountAdminRoutes`:

```ts
  // GET /api/admin/portal - toggle state plus the credentials needed to set up
  // the Home Assistant integration by hand (non-add-on deployments).
  app.get('/api/admin/portal', (c) => {
    return c.json(
      AdminPortalResponse.parse({
        enabled: settings.getPortalEnabled(),
        integrationToken: settings.getIntegrationToken(),
        portalId: settings.getPortalId(),
      }),
    )
  })

  // PUT /api/admin/portal - enable or disable the guest surface
  app.put('/api/admin/portal', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = AdminPortalPutRequest.safeParse(body)
    if (!parseResult.success) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    settings.setPortalEnabled(parseResult.data.enabled)

    return c.json({ enabled: parseResult.data.enabled })
  })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/integration/routes-admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm vitest run`

```bash
git add src/server/http/routes-admin.ts test/integration/routes-admin.test.ts
git commit -m "feat: add admin routes for the portal toggle"
```

---

### Task 8: Integration routes

**Files:**
- Create: `src/server/http/routes-integration.ts`
- Modify: `src/server/app.ts` (mount, and exempt from the session middleware)
- Test: `test/integration/routes-integration.test.ts` (create)

**Interfaces:**
- Produces: `export function mountIntegrationRoutes(app: Hono<Env>, deps: Deps): void`; routes `GET /api/integration/state` and `POST /api/integration/enabled`, authenticated by `Authorization: Bearer <settings.getIntegrationToken()>`.

- [ ] **Step 1: Write the failing test**

Create `test/integration/routes-integration.test.ts` with the same scaffolding as `test/integration/portal-toggle.test.ts`, then:

```ts
  function auth(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` }
  }

  it('returns state to a valid token', async () => {
    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: auth(settings.getIntegrationToken()),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.enabled).toBe(true)
    expect(body.portalId).toBe(settings.getPortalId())
    expect(body.lastInteraction).toBeNull()
    expect(typeof body.version).toBe('string')
    expect(typeof body.deviceCount).toBe('number')
  })

  it('rejects a missing Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/integration/state`)
    expect(res.status).toBe(401)
  })

  it('rejects a malformed Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: { Authorization: settings.getIntegrationToken() },
    })
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: auth('b'.repeat(64)),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a session cookie in place of a token', async () => {
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin-password' }),
    })
    const cookie = login.headers.get('set-cookie') ?? ''

    const res = await fetch(`${baseUrl}/api/integration/state`, { headers: { cookie } })

    expect(res.status).toBe(401)
  })

  it('disables the portal', async () => {
    const res = await fetch(`${baseUrl}/api/integration/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(settings.getIntegrationToken()) },
      body: JSON.stringify({ enabled: false }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false })
    expect(settings.getPortalEnabled()).toBe(false)
  })

  it('remains reachable while the portal is disabled', async () => {
    settings.setPortalEnabled(false)

    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: auth(settings.getIntegrationToken()),
    })

    expect(res.status).toBe(200)
    expect((await res.json()).enabled).toBe(false)
  })

  it('rejects a non-boolean enabled', async () => {
    const res = await fetch(`${baseUrl}/api/integration/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(settings.getIntegrationToken()) },
      body: JSON.stringify({ enabled: 1 }),
    })

    expect(res.status).toBe(400)
  })

  it('reports the latest interaction', async () => {
    interactions.record({
      ts: 1_700_000_000_000,
      kind: 'action',
      entityId: 'lock.front',
      label: 'Front Door',
      action: 'unlock',
      ok: true,
    })

    const res = await fetch(`${baseUrl}/api/integration/state`, {
      headers: auth(settings.getIntegrationToken()),
    })

    expect((await res.json()).lastInteraction).toEqual({
      ts: 1_700_000_000_000,
      kind: 'action',
      entityId: 'lock.front',
      label: 'Front Door',
      action: 'unlock',
      ok: true,
    })
  })

  it('cannot reach the allowlist with an integration token', async () => {
    const res = await fetch(`${baseUrl}/api/admin/allowlist`, {
      headers: auth(settings.getIntegrationToken()),
    })

    expect(res.status).toBe(401)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/integration/routes-integration.test.ts`
Expected: FAIL — 404 on `/api/integration/state`.

- [ ] **Step 3: Write the routes**

Create `src/server/http/routes-integration.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Hono, MiddlewareHandler } from 'hono'
import type { Env } from '../app.js'
import type { Deps } from './routes-guest.js'
import { IntegrationEnabledRequest, IntegrationStateResponse } from '../../shared/api.js'

/**
 * Reported to the Home Assistant integration so it can raise a repair issue
 * against an add-on too old to speak its protocol, rather than failing on a
 * missing field. Bump when the shape of /api/integration/state changes.
 */
export const INTEGRATION_API_VERSION = '1.0.0'

function tokenMatches(supplied: string, expected: string): boolean {
  // Hash both sides so timingSafeEqual always sees equal-length buffers.
  const suppliedHash = createHash('sha256').update(supplied, 'utf8').digest()
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest()

  try {
    return timingSafeEqual(suppliedHash, expectedHash)
  } catch {
    return false
  }
}

/**
 * Bearer-token routes for the Home Assistant integration.
 *
 * Deliberately no cookie or session path: this is a machine client. The token
 * opens exactly these two routes — it cannot read or write the allowlist, read
 * the audit log, or log in. It is served on the LAN-facing port because the
 * plain Docker deployment has no Supervisor network available.
 */
export function mountIntegrationRoutes(app: Hono<Env>, deps: Deps): void {
  const { allowlist, ha, settings, interactions } = deps

  const requireToken: MiddlewareHandler<Env> = async (c, next) => {
    const header = c.req.header('authorization')

    if (!header?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const supplied = header.slice('Bearer '.length).trim()

    if (!tokenMatches(supplied, settings.getIntegrationToken())) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    await next()
  }

  app.use('/api/integration/*', requireToken)

  app.get('/api/integration/state', (c) => {
    return c.json(
      IntegrationStateResponse.parse({
        portalId: settings.getPortalId(),
        enabled: settings.getPortalEnabled(),
        haStale: ha.stale,
        deviceCount: allowlist.list().length,
        version: INTEGRATION_API_VERSION,
        lastInteraction: interactions.latest(),
      }),
    )
  })

  app.post('/api/integration/enabled', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = IntegrationEnabledRequest.safeParse(body)
    if (!parseResult.success) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    settings.setPortalEnabled(parseResult.data.enabled)

    return c.json({ enabled: parseResult.data.enabled })
  })
}
```

- [ ] **Step 4: Mount the routes**

In `src/server/app.ts`, import and mount. The integration routes must be registered **before** the static-file middleware, and must not sit behind `requireSession`:

```ts
import { mountIntegrationRoutes } from './http/routes-integration.js'
```

Immediately after the `app.get('/api/health', routes.health)` line:

```ts
  // Integration routes (bearer token, no session)
  mountIntegrationRoutes(app, deps)
```

The `ingressMiddleware` runs on `*` and may set `role` to `'admin'` for Supervisor-sourced requests, but `mountIntegrationRoutes` ignores `c.var.role` entirely — a token is always required.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/integration/routes-integration.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm vitest run`

```bash
git add src/server/http/routes-integration.ts src/server/app.ts test/integration/routes-integration.test.ts
git commit -m "feat: add bearer-authenticated integration routes"
```

---

### Task 9: Supervisor discovery

**Files:**
- Create: `src/server/hassio/discovery.ts`
- Create: `test/fake-supervisor.ts`
- Modify: `src/server/index.ts` (call it at startup)
- Modify: `config.yaml` (add the `discovery` key)
- Test: `test/integration/discovery.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export const DISCOVERY_SERVICE = 'ha_guest_portal'
  export type DiscoveryOptions = {
    supervisorToken: string
    supervisorBaseUrl?: string   // default 'http://supervisor'
    portalId: string
    token: string
    port: number
  }
  export async function publishDiscovery(opts: DiscoveryOptions): Promise<boolean>
  ```
  Resolves `true` on success, `false` on any failure. Never rejects.

- [ ] **Step 1: Write the fake Supervisor**

Create `test/fake-supervisor.ts`:

```ts
import { createServer, type Server } from 'node:http'

export type DiscoveryRecord = {
  uuid: string
  addon: string
  service: string
  config: Record<string, unknown>
}

/**
 * Minimal stand-in for the Home Assistant Supervisor, covering only the
 * endpoints the add-on's discovery publication touches.
 */
export class FakeSupervisor {
  private server: Server
  private records: DiscoveryRecord[] = []
  private nextUuid = 1

  readonly token = 'fake-supervisor-token'
  readonly addonHostname = 'local-ha-guest-portal'
  readonly requests: Array<{ method: string; path: string }> = []

  /** Set to a status code to make every request fail with it. */
  failWith: number | null = null

  private constructor(server: Server) {
    this.server = server
  }

  static async start(): Promise<FakeSupervisor> {
    let instance: FakeSupervisor

    const server = createServer((req, res) => {
      instance.handle(req, res)
    })

    instance = new FakeSupervisor(server)

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })

    return instance
  }

  get baseUrl(): string {
    const address = this.server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('FakeSupervisor is not listening on a port')
    }
    return `http://127.0.0.1:${address.port}`
  }

  get discoveries(): DiscoveryRecord[] {
    return this.records
  }

  private handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    this.requests.push({ method: req.method ?? 'GET', path })

    if (this.failWith !== null) {
      res.writeHead(this.failWith, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ result: 'error' }))
      return
    }

    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end()
      return
    }

    const json = (status: number, data: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }

    if (req.method === 'GET' && path === '/addons/self/info') {
      json(200, { result: 'ok', data: { hostname: this.addonHostname, version: '0.2.0' } })
      return
    }

    if (req.method === 'GET' && path === '/discovery') {
      json(200, { result: 'ok', data: { discovery: this.records } })
      return
    }

    if (req.method === 'DELETE' && path.startsWith('/discovery/')) {
      const uuid = path.slice('/discovery/'.length)
      this.records = this.records.filter((r) => r.uuid !== uuid)
      json(200, { result: 'ok' })
      return
    }

    if (req.method === 'POST' && path === '/discovery') {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        const body = JSON.parse(raw) as { service: string; config: Record<string, unknown> }
        const uuid = `uuid-${this.nextUuid++}`
        this.records.push({
          uuid,
          addon: 'local_ha_guest_portal',
          service: body.service,
          config: body.config,
        })
        json(200, { result: 'ok', data: { uuid } })
      })
      return
    }

    res.writeHead(404).end()
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/integration/discovery.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeSupervisor } from '../fake-supervisor.ts'
import { DISCOVERY_SERVICE, publishDiscovery } from '../../src/server/hassio/discovery.ts'

describe('Supervisor discovery', () => {
  let supervisor: FakeSupervisor

  beforeEach(async () => {
    supervisor = await FakeSupervisor.start()
  })

  afterEach(async () => {
    await supervisor.stop()
  })

  function options() {
    return {
      supervisorToken: supervisor.token,
      supervisorBaseUrl: supervisor.baseUrl,
      portalId: '11111111-1111-1111-1111-111111111111',
      token: 'a'.repeat(64),
      port: 8080,
    }
  }

  it('publishes a discovery record', async () => {
    const ok = await publishDiscovery(options())

    expect(ok).toBe(true)
    expect(supervisor.discoveries).toHaveLength(1)
    expect(supervisor.discoveries[0]?.service).toBe(DISCOVERY_SERVICE)
  })

  it('publishes the connection details the integration needs', async () => {
    await publishDiscovery(options())

    expect(supervisor.discoveries[0]?.config).toEqual({
      portalId: '11111111-1111-1111-1111-111111111111',
      host: supervisor.addonHostname,
      port: 8080,
      token: 'a'.repeat(64),
    })
  })

  it('replaces its own record rather than duplicating on restart', async () => {
    await publishDiscovery(options())
    await publishDiscovery(options())

    expect(supervisor.discoveries).toHaveLength(1)
  })

  it('leaves other services alone', async () => {
    await publishDiscovery(options())
    supervisor.discoveries.push({
      uuid: 'other', addon: 'x', service: 'mqtt', config: {},
    })

    await publishDiscovery(options())

    expect(supervisor.discoveries.map((r) => r.service).sort()).toEqual([
      DISCOVERY_SERVICE,
      'mqtt',
    ])
  })

  it('returns false rather than throwing when the Supervisor errors', async () => {
    supervisor.failWith = 500

    await expect(publishDiscovery(options())).resolves.toBe(false)
  })

  it('returns false rather than throwing when the Supervisor is unreachable', async () => {
    await supervisor.stop()

    await expect(publishDiscovery(options())).resolves.toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/integration/discovery.test.ts`
Expected: FAIL — cannot resolve `hassio/discovery.ts`.

- [ ] **Step 4: Write the discovery module**

Create `src/server/hassio/discovery.ts`:

```ts
import { z } from 'zod'

/**
 * Must match the integration's `domain` in custom_components/ha_guest_portal/
 * manifest.json. Home Assistant uses the discovery service name directly as
 * the config-flow domain, so a mismatch fails silently.
 */
export const DISCOVERY_SERVICE = 'ha_guest_portal'

const DEFAULT_SUPERVISOR_URL = 'http://supervisor'
const TIMEOUT_MS = 10_000

export type DiscoveryOptions = {
  supervisorToken: string
  supervisorBaseUrl?: string
  portalId: string
  token: string
  port: number
}

const AddonInfoSchema = z.object({
  data: z.object({
    hostname: z.string(),
  }),
})

const DiscoveryListSchema = z.object({
  data: z.object({
    discovery: z.array(
      z.object({
        uuid: z.string(),
        service: z.string(),
      }),
    ),
  }),
})

/**
 * Announce this add-on to the Supervisor so Home Assistant opens a config flow
 * on the companion integration.
 *
 * Every failure is logged and swallowed: the portal must start even when the
 * Supervisor refuses. `/discovery*` needs no `hassio_api: true` in config.yaml.
 */
export async function publishDiscovery(opts: DiscoveryOptions): Promise<boolean> {
  const baseUrl = opts.supervisorBaseUrl ?? DEFAULT_SUPERVISOR_URL

  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${opts.supervisorToken}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  }

  try {
    // 1. Our own hostname on the internal network.
    const infoResponse = await request('/addons/self/info')
    if (!infoResponse.ok) {
      console.error(`Discovery: /addons/self/info returned ${infoResponse.status}`)
      return false
    }
    const info = AddonInfoSchema.parse(await infoResponse.json())

    // 2. Remove any record we left behind before this restart, so a restart
    //    replaces rather than accumulates.
    const listResponse = await request('/discovery')
    if (listResponse.ok) {
      const list = DiscoveryListSchema.parse(await listResponse.json())
      const stale = list.data.discovery.filter((r) => r.service === DISCOVERY_SERVICE)

      for (const record of stale) {
        await request(`/discovery/${record.uuid}`, { method: 'DELETE' })
      }
    }

    // 3. Announce.
    const postResponse = await request('/discovery', {
      method: 'POST',
      body: JSON.stringify({
        service: DISCOVERY_SERVICE,
        config: {
          portalId: opts.portalId,
          host: info.data.hostname,
          port: opts.port,
          token: opts.token,
        },
      }),
    })

    if (!postResponse.ok) {
      console.error(`Discovery: POST /discovery returned ${postResponse.status}`)
      return false
    }

    console.log(`Discovery: announced ${DISCOVERY_SERVICE} to the Supervisor`)
    return true
  } catch (error) {
    // Strip the token from any error text before logging.
    const message = error instanceof Error ? error.message.replaceAll(opts.token, '[REDACTED]') : String(error)
    console.error(`Discovery: failed to announce (${message})`)
    return false
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/integration/discovery.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Call it at startup**

In `src/server/index.ts`, import:

```ts
import { publishDiscovery } from './hassio/discovery.js'
```

After the servers begin listening (after the ingress `listen` block), add:

```ts
  // Announce to the Supervisor so HA can discover the companion integration.
  // Add-on mode only; SUPERVISOR_TOKEN is never set under plain Docker.
  const supervisorToken = process.env.SUPERVISOR_TOKEN
  if (supervisorToken) {
    void publishDiscovery({
      supervisorToken,
      portalId: settings.getPortalId(),
      token: settings.getIntegrationToken(),
      port: cfg.port,
    })
  }
```

`void` is deliberate: discovery must not delay or block startup.

- [ ] **Step 7: Declare discovery in the add-on config**

In `config.yaml`, after the `homeassistant_api: true` line:

```yaml
# Announces the add-on to the Supervisor so Home Assistant offers the companion
# custom integration. The service name must match manifest.json's domain.
# /discovery* requires no hassio_api privilege.
discovery:
  - ha_guest_portal
```

- [ ] **Step 8: Verify and commit**

Run: `pnpm typecheck && pnpm vitest run`

```bash
git add src/server/hassio/discovery.ts src/server/index.ts config.yaml test/fake-supervisor.ts test/integration/discovery.test.ts
git commit -m "feat: announce the add-on to the Supervisor for integration discovery"
```

---

## Phase 2 — Web UI

### Task 10: Web store and API client

**Files:**
- Modify: `src/web/store.ts` (portal frame, `portalEnabled` in the snapshot)
- Modify: `src/web/api.ts` (`getAdminPortal`, `putAdminPortal`, `setStorePortalEnabled` plumbing)
- Test: `test/unit/web-store.test.ts` (append), `test/unit/web-api.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  // store.ts
  export type DeviceStoreSnapshot = { devices: Device[]; stale: boolean; connected: boolean; portalEnabled: boolean }
  export function setPortalEnabled(enabled: boolean): void
  // api.ts
  export async function getAdminPortal(): Promise<ApiResult<{ enabled: boolean; integrationToken: string; portalId: string }>>
  export async function putAdminPortal(enabled: boolean): Promise<ApiResult<void>>
  ```

- [ ] **Step 1: Write the failing store test**

Append to `test/unit/web-store.test.ts`:

```ts
describe('portal frame', () => {
  beforeEach(() => {
    resetStore()
  })

  it('defaults portalEnabled to true', () => {
    expect(getSnapshot().portalEnabled).toBe(true)
  })

  it('applies a portal frame', () => {
    applyFrame({ type: 'portal', enabled: false })
    expect(getSnapshot().portalEnabled).toBe(false)
  })

  it('notifies subscribers on a portal frame', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeForTest(listener)

    applyFrame({ type: 'portal', enabled: false })

    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('leaves devices untouched on a portal frame', () => {
    applyFrame({
      type: 'snapshot',
      stale: false,
      devices: [
        {
          entityId: 'light.porch',
          label: 'Porch',
          domain: 'light',
          allowedActions: ['turn_on'],
          sortOrder: 0,
          state: { state: 'off', attributes: {}, stale: false },
        },
      ],
    })

    applyFrame({ type: 'portal', enabled: false })

    expect(getSnapshot().devices).toHaveLength(1)
  })

  it('setPortalEnabled updates the snapshot', () => {
    setPortalEnabled(false)
    expect(getSnapshot().portalEnabled).toBe(false)
  })
})
```

If `test/unit/web-store.test.ts` has no `subscribeForTest` helper, subscribe through `useDeviceStore`'s underlying mechanism the way the existing tests in that file already do, and mirror their approach.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/unit/web-store.test.ts`
Expected: FAIL — `portalEnabled` is undefined.

- [ ] **Step 3: Update the store**

In `src/web/store.ts`:

Extend the snapshot type and both initialisers (the module-level `snapshot` and the one inside `resetStore`):

```ts
export type DeviceStoreSnapshot = {
  devices: Device[]
  stale: boolean
  connected: boolean
  portalEnabled: boolean
}
```

```ts
let snapshot: DeviceStoreSnapshot = {
  devices: [],
  stale: false,
  connected: false,
  portalEnabled: true,
}
```

Every existing object literal that rebuilds `snapshot` inside `applyFrame` must carry `portalEnabled: snapshot.portalEnabled` through — there are three (`snapshot`, `patch`, `degraded` branches). Add a fourth branch at the end of `applyFrame`:

```ts
  } else if (validFrame.type === 'portal') {
    snapshot = {
      ...snapshot,
      portalEnabled: validFrame.enabled,
    }
    notifySubscribers()
  }
```

Add the exported setter next to `setConnected`:

```ts
// Exported so App can seed the value from /api/session. Guests have their
// stream closed when the portal is disabled, so they cannot rely on the
// 'portal' SSE frame; the session response is their source of truth.
export function setPortalEnabled(enabled: boolean): void {
  snapshot = {
    ...snapshot,
    portalEnabled: enabled,
  }
  notifySubscribers()
}
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `pnpm vitest run test/unit/web-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing API test**

Append to `test/unit/web-api.test.ts`, following that file's existing `fetch`-mocking style:

```ts
describe('admin portal API', () => {
  it('fetches portal state', async () => {
    mockFetchOnce(200, {
      enabled: false,
      integrationToken: 'a'.repeat(64),
      portalId: '11111111-1111-1111-1111-111111111111',
    })

    const result = await getAdminPortal()

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.enabled).toBe(false)
  })

  it('reports a failed portal fetch', async () => {
    mockFetchOnce(403, { error: 'Forbidden' })

    const result = await getAdminPortal()

    expect(result.ok).toBe(false)
  })

  it('puts a new enabled value', async () => {
    mockFetchOnce(200, { enabled: false })

    const result = await putAdminPortal(false)

    expect(result.ok).toBe(true)
  })

  it('reports a failed put', async () => {
    mockFetchOnce(500, { error: 'boom' })

    const result = await putAdminPortal(false)

    expect(result.ok).toBe(false)
  })
})
```

Replace `mockFetchOnce` with whatever helper that file already uses.

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm vitest run test/unit/web-api.test.ts`
Expected: FAIL — `getAdminPortal` is not exported.

- [ ] **Step 7: Add the API functions**

In `src/web/api.ts`, extend the `@shared/api.js` import with `AdminPortalResponse`, then append:

```ts
export async function getAdminPortal(): Promise<
  ApiResult<{ enabled: boolean; integrationToken: string; portalId: string }>
> {
  const response = await fetch('/api/admin/portal', {
    credentials: 'same-origin',
  })

  return handleResponse(response, AdminPortalResponse)
}

export async function putAdminPortal(enabled: boolean): Promise<ApiResult<void>> {
  const response = await fetch('/api/admin/portal', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
    credentials: 'same-origin',
  })

  if (!response.ok) {
    if (response.status === 401 && unauthorizedCallback !== null) {
      unauthorizedCallback()
    }

    return {
      ok: false,
      status: response.status,
    }
  }

  return { ok: true, data: undefined }
}
```

- [ ] **Step 8: Verify and commit**

Run: `pnpm typecheck && pnpm vitest run`

```bash
git add src/web/store.ts src/web/api.ts test/unit/web-store.test.ts test/unit/web-api.test.ts
git commit -m "feat: track portal enablement in the web store and API client"
```

---

### Task 11: Admin toggle UI

**Files:**
- Create: `src/web/components/PortalToggle.tsx`
- Modify: `src/web/routes/Admin.tsx` (render it above "Add Entity")
- Test: `test/unit/portal-toggle-ui.test.tsx` (create)

**Interfaces:**
- Produces: `export function PortalToggle(): ReactElement` — self-contained; loads its own state from `getAdminPortal()`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/portal-toggle-ui.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PortalToggle } from '../../src/web/components/PortalToggle.tsx'
import * as api from '../../src/web/api.ts'

vi.mock('../../src/web/api.ts')

describe('PortalToggle', () => {
  beforeEach(() => {
    vi.mocked(api.getAdminPortal).mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
      },
    })
    vi.mocked(api.putAdminPortal).mockResolvedValue({ ok: true, data: undefined })
  })

  it('shows the portal as enabled', async () => {
    render(<PortalToggle />)

    await waitFor(() => {
      expect(screen.getByTestId('portal-toggle')).toBeChecked()
    })
  })

  it('disables the portal on click, without a separate save', async () => {
    render(<PortalToggle />)
    await waitFor(() => screen.getByTestId('portal-toggle'))

    await userEvent.click(screen.getByTestId('portal-toggle'))

    expect(api.putAdminPortal).toHaveBeenCalledWith(false)
  })

  it('shows a banner while disabled', async () => {
    vi.mocked(api.getAdminPortal).mockResolvedValue({
      ok: true,
      data: {
        enabled: false,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
      },
    })

    render(<PortalToggle />)

    await waitFor(() => {
      expect(screen.getByTestId('portal-disabled-banner')).toBeTruthy()
    })
  })

  it('reverts the toggle when the save fails', async () => {
    vi.mocked(api.putAdminPortal).mockResolvedValue({ ok: false, status: 500 })
    render(<PortalToggle />)
    await waitFor(() => screen.getByTestId('portal-toggle'))

    await userEvent.click(screen.getByTestId('portal-toggle'))

    await waitFor(() => {
      expect(screen.getByTestId('portal-toggle')).toBeChecked()
    })
    expect(screen.getByTestId('portal-toggle-error')).toBeTruthy()
  })

  it('hides the integration token until revealed', async () => {
    render(<PortalToggle />)
    await waitFor(() => screen.getByTestId('portal-toggle'))

    expect(screen.queryByText('a'.repeat(64))).toBeNull()

    await userEvent.click(screen.getByTestId('reveal-token'))

    expect(screen.getByTestId('integration-token').textContent).toBe('a'.repeat(64))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/unit/portal-toggle-ui.test.tsx`
Expected: FAIL — cannot resolve `PortalToggle.tsx`.

- [ ] **Step 3: Write the component**

Create `src/web/components/PortalToggle.tsx`. Match the existing inline-style convention used throughout `Admin.tsx`:

```tsx
import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import * as api from '../api.js'

export function PortalToggle(): ReactElement {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [token, setToken] = useState<string>('')
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const result = await api.getAdminPortal()
    if (!result.ok) {
      setError('Failed to load portal state')
      return
    }
    setEnabled(result.data.enabled)
    setToken(result.data.integrationToken)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleToggle(): Promise<void> {
    if (enabled === null || saving) return

    const next = !enabled

    // Apply immediately: a kill-switch that needs a second click to take
    // effect is a defect. Revert if the server refuses.
    setEnabled(next)
    setSaving(true)
    setError(null)

    const result = await api.putAdminPortal(next)
    setSaving(false)

    if (!result.ok) {
      setEnabled(!next)
      setError('Failed to update the portal. Try again.')
    }
  }

  if (enabled === null) {
    return <section data-testid="portal-toggle-section">Loading portal state...</section>
  }

  return (
    <section data-testid="portal-toggle-section" style={{ marginBottom: '24px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Guest Portal</h2>

      <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <input
          data-testid="portal-toggle"
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={() => {
            void handleToggle()
          }}
        />
        <span style={{ fontSize: '14px' }}>
          {enabled ? 'Enabled — guests can log in' : 'Disabled — guests are blocked'}
        </span>
      </label>

      {!enabled && (
        <div
          data-testid="portal-disabled-banner"
          style={{
            marginTop: '8px',
            padding: '8px 12px',
            fontSize: '13px',
            color: '#8a6d3b',
            backgroundColor: '#fcf8e3',
            border: '1px solid #faebcc',
            borderRadius: '4px',
          }}
        >
          The guest portal is off. Guests cannot log in and anyone already
          signed in has been blocked. This admin page is unaffected.
        </div>
      )}

      {error !== null && (
        <div data-testid="portal-toggle-error" style={{ marginTop: '8px', color: '#d9534f', fontSize: '13px' }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: '12px', fontSize: '12px', color: '#666' }}>
        <div style={{ marginBottom: '4px' }}>
          Integration token — only needed to set up the Home Assistant
          integration by hand. Add-on installations are discovered automatically.
        </div>
        {tokenRevealed ? (
          <code
            data-testid="integration-token"
            style={{ wordBreak: 'break-all', fontSize: '11px' }}
          >
            {token}
          </code>
        ) : (
          <button
            type="button"
            data-testid="reveal-token"
            onClick={() => setTokenRevealed(true)}
            style={{ padding: '4px 8px', fontSize: '12px', cursor: 'pointer' }}
          >
            Show token
          </button>
        )}
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/portal-toggle-ui.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Render it in Admin**

In `src/web/routes/Admin.tsx`, add the import:

```tsx
import { PortalToggle } from '../components/PortalToggle.js'
```

and render `<PortalToggle />` immediately after the closing `</div>` of the header row (the flex container holding `<h1>Admin Portal</h1>` and the logout button), before the "Add Entity" `<section>`.

The `loading` and `error` early returns in `Admin` guard the *allowlist*. Leave them as they are: if Home Assistant is unreachable the catalog cannot load, but that is precisely when you may most want the kill-switch — so also render `<PortalToggle />` inside the `error` early-return block, above the retry button.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm vitest run`

```bash
git add src/web/components/PortalToggle.tsx src/web/routes/Admin.tsx test/unit/portal-toggle-ui.test.tsx
git commit -m "feat: add the portal toggle to the admin UI"
```

---

### Task 12: Guest disabled screen

**Files:**
- Create: `src/web/routes/PortalDisabled.tsx`
- Modify: `src/web/App.tsx`
- Test: `test/unit/portal-disabled.test.tsx` (create)

**Interfaces:**
- Produces: `export function PortalDisabled({ onRetry }: { onRetry: () => void }): ReactElement`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/portal-disabled.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PortalDisabled } from '../../src/web/routes/PortalDisabled.tsx'

describe('PortalDisabled', () => {
  it('explains that the portal is unavailable', () => {
    render(<PortalDisabled onRetry={() => {}} />)

    expect(screen.getByTestId('portal-disabled-screen')).toBeTruthy()
  })

  it('does not blame the guest or mention an error', () => {
    render(<PortalDisabled onRetry={() => {}} />)

    const text = screen.getByTestId('portal-disabled-screen').textContent ?? ''
    expect(text.toLowerCase()).not.toContain('error')
    expect(text.toLowerCase()).not.toContain('forbidden')
  })

  it('calls onRetry when the retry button is pressed', async () => {
    const onRetry = vi.fn()
    render(<PortalDisabled onRetry={onRetry} />)

    await userEvent.click(screen.getByTestId('portal-disabled-retry'))

    expect(onRetry).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/unit/portal-disabled.test.tsx`
Expected: FAIL — cannot resolve `PortalDisabled.tsx`.

- [ ] **Step 3: Write the component**

Create `src/web/routes/PortalDisabled.tsx`:

```tsx
import type { ReactElement } from 'react'

type PortalDisabledProps = {
  onRetry: () => void
}

export function PortalDisabled({ onRetry }: PortalDisabledProps): ReactElement {
  return (
    <div
      data-testid="portal-disabled-screen"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '24px',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: '22px', fontWeight: 600, marginBottom: '12px' }}>
        The guest portal is currently unavailable
      </h1>
      <p style={{ fontSize: '15px', color: '#555', maxWidth: '360px', marginBottom: '20px' }}>
        Your host has turned it off. It will come back on its own once they turn
        it back on — no need to sign in again.
      </p>
      <button
        type="button"
        data-testid="portal-disabled-retry"
        onClick={onRetry}
        style={{
          padding: '10px 20px',
          fontSize: '14px',
          fontWeight: 600,
          backgroundColor: '#5cb85c',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
        }}
      >
        Check again
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/unit/portal-disabled.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Route to it in App**

In `src/web/App.tsx`:

Extend the imports:

```tsx
import { PortalDisabled } from './routes/PortalDisabled.js'
import { setPortalEnabled, useDeviceStore } from './store.js'
```

Read `portalEnabled` from the store:

```tsx
  const { connected, portalEnabled } = useDeviceStore()
```

Seed it from the session in the mount effect:

```tsx
  useEffect(() => {
    async function checkSession(): Promise<void> {
      const session = await getSession()
      setRole(session?.role ?? null)
      if (session !== null) {
        setPortalEnabled(session.portalEnabled)
      }
    }

    void checkSession()
  }, [])
```

Update the stream-drop recheck to also refresh the flag — this is the fast path by which a guest reaches the disabled screen, since disabling closes their stream:

```tsx
      async function recheckSession(): Promise<void> {
        const session = await getSession()
        if (session === null) {
          setRole(null)
          return
        }
        setPortalEnabled(session.portalEnabled)
      }
```

Add a retry callback and the 15s poll, after the recheck effect:

```tsx
  const recheckPortal = useCallback(async (): Promise<void> => {
    const session = await getSession()
    if (session === null) {
      setRole(null)
      return
    }
    setPortalEnabled(session.portalEnabled)
  }, [])

  // While a guest is looking at the disabled screen their stream is closed, so
  // nothing will tell them the portal came back. Poll until it does.
  useEffect(() => {
    if (portalEnabled || role !== 'guest') return

    const timer = setInterval(() => {
      void recheckPortal()
    }, 15_000)

    return () => {
      clearInterval(timer)
    }
  }, [portalEnabled, role, recheckPortal])
```

Add `useCallback` to the React import.

Finally, insert the route immediately before the `isAdminPath` routing block:

```tsx
  if (role === 'guest' && !portalEnabled) {
    return (
      <PortalDisabled
        onRetry={() => {
          void recheckPortal()
        }}
      />
    )
  }
```

Placing it after the `role === null` check and before the admin routing keeps admins — including ingress admins — entirely unaffected.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm vitest run`

```bash
git add src/web/routes/PortalDisabled.tsx src/web/App.tsx test/unit/portal-disabled.test.tsx
git commit -m "feat: show guests a disabled screen while the portal is off"
```

---

### Task 13: End-to-end toggle test

**Files:**
- Modify: `test/e2e/portal.spec.ts` (append a test)

**Interfaces:**
- Consumes: everything from Tasks 1–12.

- [ ] **Step 1: Write the failing test**

Append to `test/e2e/portal.spec.ts`, matching that file's existing harness setup and login helpers:

```ts
test('an admin can disable the portal and a guest is blocked, then restored', async ({ browser }) => {
  const adminContext = await browser.newContext()
  const guestContext = await browser.newContext()

  const adminPage = await adminContext.newPage()
  const guestPage = await guestContext.newPage()

  // Guest signs in and reaches the device list.
  await guestPage.goto(harness.baseUrl)
  await guestPage.getByTestId('password-input').fill(GUEST_PASSWORD)
  await guestPage.getByTestId('login-submit').click()
  await expect(guestPage.getByTestId('guest-screen')).toBeVisible()

  // Admin signs in and turns the portal off.
  await adminPage.goto(`${harness.baseUrl}/admin`)
  await adminPage.getByTestId('password-input').fill(ADMIN_PASSWORD)
  await adminPage.getByTestId('login-submit').click()
  await expect(adminPage.getByTestId('portal-toggle')).toBeChecked()

  await adminPage.getByTestId('portal-toggle').uncheck()
  await expect(adminPage.getByTestId('portal-disabled-banner')).toBeVisible()

  // The guest's stream is dropped, the client rechecks, and it lands here.
  await expect(guestPage.getByTestId('portal-disabled-screen')).toBeVisible({ timeout: 15_000 })

  // The admin page keeps working while the portal is off.
  await expect(adminPage.getByTestId('admin-screen')).toBeVisible()

  // Turning it back on restores the guest without a fresh login.
  await adminPage.getByTestId('portal-toggle').check()
  await guestPage.getByTestId('portal-disabled-retry').click()
  await expect(guestPage.getByTestId('guest-screen')).toBeVisible()

  await adminContext.close()
  await guestContext.close()
})
```

Adjust `password-input`, `login-submit`, `guest-screen`, and `GUEST_PASSWORD` / `ADMIN_PASSWORD` to the identifiers the existing spec already uses — run `grep -n "getByTestId\|PASSWORD" test/e2e/portal.spec.ts` first and reuse them verbatim.

- [ ] **Step 2: Run the test**

Run: `pnpm build && pnpm test:e2e -g "disable the portal"`
Expected: PASS. `pnpm build` is required — the e2e harness serves the built SPA from `dist/web`, so an unbuilt change will silently test stale code.

- [ ] **Step 3: Run the full e2e suite**

Run: `pnpm test:e2e`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/portal.spec.ts
git commit -m "test: end-to-end coverage for the portal toggle"
```

---

## Phase 3 — The Home Assistant integration

### Task 14: Integration scaffolding and packaging

**Files:**
- Create: `custom_components/ha_guest_portal/__init__.py`, `const.py`, `manifest.json`, `strings.json`, `translations/en.json`
- Create: `hacs.json`, `brand/icon.png`, `pyproject.toml`, `tests/conftest.py`, `tests/__init__.py`
- Modify: `.dockerignore`, `biome.json`, `.gitignore`

**Interfaces:**
- Produces: `DOMAIN = 'ha_guest_portal'`, `DEFAULT_PORT = 8080`, `SCAN_INTERVAL = timedelta(seconds=10)` in `const.py`. A working `pytest` invocation.

- [ ] **Step 1: Create the Python project config**

Create `pyproject.toml` at the repo root:

```toml
[project]
name = "ha-guest-portal-integration"
version = "0.1.0"
description = "Home Assistant integration for the Guest Portal add-on"
requires-python = ">=3.13"

[dependency-groups]
dev = [
    "pytest-homeassistant-custom-component==0.13.366",
    "ruff==0.16.8",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"

[tool.ruff]
target-version = "py313"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "SIM"]
```

- [ ] **Step 2: Create the integration constants and manifest**

Create `custom_components/ha_guest_portal/const.py`:

```python
"""Constants for the Home Assistant Guest Portal integration."""

from datetime import timedelta

DOMAIN = "ha_guest_portal"

DEFAULT_PORT = 8080
SCAN_INTERVAL = timedelta(seconds=10)

CONF_TOKEN = "token"

# The oldest /api/integration/state contract this integration can read. The
# portal reports its own version; anything below this raises a repair issue
# telling the user to update the add-on.
MIN_PORTAL_VERSION = "1.0.0"
```

Create `custom_components/ha_guest_portal/manifest.json`. hassfest requires `domain` and `name` first, then the remaining keys in alphabetical order:

```json
{
  "domain": "ha_guest_portal",
  "name": "Home Assistant Guest Portal",
  "codeowners": ["@ajma"],
  "config_flow": true,
  "documentation": "https://github.com/ajma/ha-guest-portal",
  "integration_type": "service",
  "iot_class": "local_polling",
  "issue_tracker": "https://github.com/ajma/ha-guest-portal/issues",
  "requirements": [],
  "version": "0.1.0"
}
```

- [ ] **Step 3: Create the HACS manifest and brand asset**

Create `hacs.json`:

```json
{
  "name": "Home Assistant Guest Portal",
  "content_in_root": false,
  "render_readme": true,
  "homeassistant": "2026.9.0"
}
```

Create the brand icon — HACS requires `brand/icon.png` to exist:

```bash
mkdir -p brand
python3 -c "
import struct, zlib
# 256x256 solid slate-blue PNG
w = h = 256
rgb = (61, 90, 128)
raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
def chunk(tag, data):
    body = tag + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))
png = (b'\x89PNG\r\n\x1a\n'
       + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(raw))
       + chunk(b'IEND', b''))
open('brand/icon.png','wb').write(png)
"
```

This is a placeholder. Replace it with a real icon before publishing to HACS.

- [ ] **Step 4: Create the minimal integration entry point**

Create `custom_components/ha_guest_portal/__init__.py`:

```python
"""The Home Assistant Guest Portal integration."""

from __future__ import annotations
```

Create `custom_components/ha_guest_portal/translations/en.json` and `custom_components/ha_guest_portal/strings.json` with identical content:

```json
{
  "config": {
    "step": {
      "user": {
        "title": "Connect to the Guest Portal",
        "description": "Enter the address of the Guest Portal add-on and the integration token shown on its admin page.",
        "data": {
          "host": "Host",
          "port": "Port",
          "token": "Integration token"
        }
      },
      "hassio_confirm": {
        "title": "Guest Portal add-on discovered",
        "description": "Set up the Home Assistant Guest Portal add-on?"
      },
      "reauth_confirm": {
        "title": "Reconnect to the Guest Portal",
        "description": "The integration token was rejected. Enter the current token from the portal's admin page.",
        "data": {
          "token": "Integration token"
        }
      }
    },
    "error": {
      "cannot_connect": "Could not reach the Guest Portal at that address.",
      "invalid_auth": "The Guest Portal rejected that token."
    },
    "abort": {
      "already_configured": "This Guest Portal is already set up.",
      "reauth_successful": "Reconnected to the Guest Portal."
    }
  },
  "entity": {
    "switch": {
      "portal": {
        "name": "Guest portal"
      }
    },
    "sensor": {
      "last_interaction": {
        "name": "Last interaction"
      }
    }
  }
}
```

- [ ] **Step 5: Create the test scaffolding**

Create `tests/__init__.py` (empty) and `tests/conftest.py`:

```python
"""Shared fixtures for the Guest Portal integration tests."""

import pytest

pytest_plugins = "pytest_homeassistant_custom_component.plugins"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Load custom_components/ in every test.

    Without this, Home Assistant's test harness refuses to see the
    integration and every config-flow test fails with 'Integration not found'.
    """
    yield
```

- [ ] **Step 6: Exclude Python from the image and the JS tooling**

Append to `.dockerignore`:

```
# Home Assistant integration — runs inside HA core, never in this container
custom_components
brand
hacs.json
pyproject.toml
uv.lock
tests
.venv
__pycache__
.pytest_cache
.ruff_cache
```

Note `tests` (the Python directory) is distinct from `test` (the TypeScript one), which is already ignored.

In `biome.json`, add `custom_components` and `brand` to the ignore list. If the file has no `files.includes`/`files.ignore` key yet, add:

```json
  "files": {
    "ignoreUnknown": true,
    "includes": ["**", "!custom_components/**", "!brand/**", "!.venv/**"]
  }
```

merging with whatever `files` block already exists rather than replacing it.

Append to `.gitignore`:

```
.venv
__pycache__/
.pytest_cache/
.ruff_cache/
```

- [ ] **Step 7: Verify the Python environment installs and collects**

Run:

```bash
uv sync --group dev
uv run pytest --collect-only
```

Expected: `uv sync` succeeds; pytest collects 0 tests without error. If `uv` is not installed, run `curl -LsSf https://astral.sh/uv/install.sh | sh` first.

- [ ] **Step 8: Verify the JS side is unaffected**

Run: `pnpm lint && pnpm typecheck && pnpm vitest run`
Expected: PASS. Biome must not report on any `.py` or `custom_components` file.

- [ ] **Step 9: Commit**

```bash
git add custom_components hacs.json brand pyproject.toml tests .dockerignore biome.json .gitignore
git commit -m "feat: scaffold the Home Assistant custom integration"
```

---

### Task 15: The portal API client

**Files:**
- Create: `custom_components/ha_guest_portal/api.py`
- Test: `tests/test_api.py`

**Interfaces:**
- Produces:
  ```python
  class PortalError(Exception): ...
  class PortalConnectionError(PortalError): ...
  class PortalAuthError(PortalError): ...

  @dataclass(frozen=True)
  class Interaction:
      ts: int
      kind: str
      entity_id: str | None
      label: str | None
      action: str | None
      ok: bool

  @dataclass(frozen=True)
  class PortalState:
      portal_id: str
      enabled: bool
      ha_stale: bool
      device_count: int
      version: str
      last_interaction: Interaction | None

  class PortalApi:
      def __init__(self, session: ClientSession, host: str, port: int, token: str) -> None
      async def async_get_state(self) -> PortalState
      async def async_set_enabled(self, enabled: bool) -> None
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/test_api.py`:

```python
"""Tests for the Guest Portal HTTP client."""

import pytest
from aiohttp import ClientSession, web

from custom_components.ha_guest_portal.api import (
    PortalApi,
    PortalAuthError,
    PortalConnectionError,
)

STATE = {
    "portalId": "11111111-1111-1111-1111-111111111111",
    "enabled": True,
    "haStale": False,
    "deviceCount": 3,
    "version": "1.0.0",
    "lastInteraction": {
        "ts": 1700000000000,
        "kind": "action",
        "entityId": "lock.front",
        "label": "Front Door",
        "action": "unlock",
        "ok": True,
    },
}


@pytest.fixture
async def portal(aiohttp_server):
    """Serve a stub portal and return (api, recorded_requests)."""
    recorded: list[dict] = []

    async def handle_state(request: web.Request) -> web.Response:
        recorded.append({"path": request.path, "auth": request.headers.get("Authorization")})
        if request.headers.get("Authorization") != "Bearer good-token":
            return web.json_response({"error": "Unauthorized"}, status=401)
        return web.json_response(STATE)

    async def handle_enabled(request: web.Request) -> web.Response:
        body = await request.json()
        recorded.append({"path": request.path, "body": body})
        if request.headers.get("Authorization") != "Bearer good-token":
            return web.json_response({"error": "Unauthorized"}, status=401)
        return web.json_response({"enabled": body["enabled"]})

    app = web.Application()
    app.router.add_get("/api/integration/state", handle_state)
    app.router.add_post("/api/integration/enabled", handle_enabled)

    server = await aiohttp_server(app)

    async with ClientSession() as session:
        yield PortalApi(session, "127.0.0.1", server.port, "good-token"), recorded


async def test_get_state_parses_the_payload(portal):
    api, _ = portal

    state = await api.async_get_state()

    assert state.portal_id == "11111111-1111-1111-1111-111111111111"
    assert state.enabled is True
    assert state.device_count == 3
    assert state.version == "1.0.0"
    assert state.last_interaction is not None
    assert state.last_interaction.entity_id == "lock.front"
    assert state.last_interaction.kind == "action"


async def test_get_state_sends_the_bearer_token(portal):
    api, recorded = portal

    await api.async_get_state()

    assert recorded[0]["auth"] == "Bearer good-token"


async def test_get_state_handles_a_null_interaction(aiohttp_server):
    async def handle(_request: web.Request) -> web.Response:
        return web.json_response({**STATE, "lastInteraction": None})

    app = web.Application()
    app.router.add_get("/api/integration/state", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "good-token")
        state = await api.async_get_state()

    assert state.last_interaction is None


async def test_get_state_raises_auth_error_on_401(aiohttp_server):
    async def handle(_request: web.Request) -> web.Response:
        return web.json_response({"error": "Unauthorized"}, status=401)

    app = web.Application()
    app.router.add_get("/api/integration/state", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "bad-token")
        with pytest.raises(PortalAuthError):
            await api.async_get_state()


async def test_get_state_raises_connection_error_when_unreachable():
    async with ClientSession() as session:
        # Port 1 is reserved and never listening.
        api = PortalApi(session, "127.0.0.1", 1, "good-token")
        with pytest.raises(PortalConnectionError):
            await api.async_get_state()


async def test_get_state_raises_connection_error_on_a_malformed_payload(aiohttp_server):
    async def handle(_request: web.Request) -> web.Response:
        return web.json_response({"nonsense": True})

    app = web.Application()
    app.router.add_get("/api/integration/state", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "good-token")
        with pytest.raises(PortalConnectionError):
            await api.async_get_state()


async def test_set_enabled_posts_the_value(portal):
    api, recorded = portal

    await api.async_set_enabled(False)

    assert recorded[-1]["body"] == {"enabled": False}


async def test_set_enabled_raises_auth_error_on_401(aiohttp_server):
    async def handle(_request: web.Request) -> web.Response:
        return web.json_response({"error": "Unauthorized"}, status=401)

    app = web.Application()
    app.router.add_post("/api/integration/enabled", handle)
    server = await aiohttp_server(app)

    async with ClientSession() as session:
        api = PortalApi(session, "127.0.0.1", server.port, "bad-token")
        with pytest.raises(PortalAuthError):
            await api.async_set_enabled(True)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_api.py`
Expected: FAIL — `ModuleNotFoundError: custom_components.ha_guest_portal.api`.

- [ ] **Step 3: Write the client**

Create `custom_components/ha_guest_portal/api.py`:

```python
"""HTTP client for the Guest Portal add-on's integration API."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import aiohttp
from aiohttp import ClientSession

TIMEOUT = aiohttp.ClientTimeout(total=10)


class PortalError(Exception):
    """Base error for the Guest Portal client."""


class PortalConnectionError(PortalError):
    """The portal could not be reached, or answered with something unusable."""


class PortalAuthError(PortalError):
    """The portal rejected the integration token."""


@dataclass(frozen=True)
class Interaction:
    """The most recent guest interaction reported by the portal."""

    ts: int
    kind: str
    entity_id: str | None
    label: str | None
    action: str | None
    ok: bool


@dataclass(frozen=True)
class PortalState:
    """A snapshot of the portal, as returned by /api/integration/state."""

    portal_id: str
    enabled: bool
    ha_stale: bool
    device_count: int
    version: str
    last_interaction: Interaction | None


def _parse_interaction(raw: Any) -> Interaction | None:
    if raw is None:
        return None

    return Interaction(
        ts=int(raw["ts"]),
        kind=str(raw["kind"]),
        entity_id=raw["entityId"],
        label=raw["label"],
        action=raw["action"],
        ok=bool(raw["ok"]),
    )


def _parse_state(raw: Any) -> PortalState:
    return PortalState(
        portal_id=str(raw["portalId"]),
        enabled=bool(raw["enabled"]),
        ha_stale=bool(raw["haStale"]),
        device_count=int(raw["deviceCount"]),
        version=str(raw["version"]),
        last_interaction=_parse_interaction(raw["lastInteraction"]),
    )


class PortalApi:
    """Talks to the two bearer-authenticated routes the portal exposes."""

    def __init__(self, session: ClientSession, host: str, port: int, token: str) -> None:
        """Store the connection details. No I/O happens here."""
        self._session = session
        self._base_url = f"http://{host}:{port}"
        self._token = token

    @property
    def base_url(self) -> str:
        """The portal's base URL, for logging and diagnostics."""
        return self._base_url

    async def _request(self, method: str, path: str, json: Any = None) -> Any:
        try:
            async with self._session.request(
                method,
                f"{self._base_url}{path}",
                json=json,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=TIMEOUT,
            ) as response:
                if response.status == 401:
                    raise PortalAuthError("The portal rejected the integration token")

                if response.status >= 400:
                    raise PortalConnectionError(f"The portal returned HTTP {response.status}")

                return await response.json()
        except PortalError:
            raise
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            raise PortalConnectionError(f"Could not reach the portal: {err}") from err

    async def async_get_state(self) -> PortalState:
        """Fetch the portal's current state."""
        raw = await self._request("GET", "/api/integration/state")

        try:
            return _parse_state(raw)
        except (KeyError, TypeError, ValueError) as err:
            # An add-on too old to speak this protocol looks exactly like this.
            raise PortalConnectionError(f"Unexpected response from the portal: {err}") from err

    async def async_set_enabled(self, enabled: bool) -> None:
        """Enable or disable the guest portal."""
        await self._request("POST", "/api/integration/enabled", json={"enabled": enabled})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_api.py -v`
Expected: PASS, 8 tests.

- [ ] **Step 5: Lint and commit**

Run: `uv run ruff check custom_components tests && uv run ruff format --check custom_components tests`

```bash
git add custom_components/ha_guest_portal/api.py tests/test_api.py
git commit -m "feat: add the Guest Portal HTTP client"
```

---

### Task 16: Coordinator and entry setup

**Files:**
- Create: `custom_components/ha_guest_portal/coordinator.py`
- Modify: `custom_components/ha_guest_portal/__init__.py`
- Test: `tests/test_init.py`

**Interfaces:**
- Consumes: `PortalApi`, `PortalState`, `PortalAuthError`, `PortalConnectionError` (Task 15); `DOMAIN`, `SCAN_INTERVAL`, `CONF_TOKEN` (Task 14).
- Produces:
  ```python
  type GuestPortalConfigEntry = ConfigEntry[GuestPortalCoordinator]
  class GuestPortalCoordinator(DataUpdateCoordinator[PortalState]):
      def __init__(self, hass: HomeAssistant, entry: GuestPortalConfigEntry, api: PortalApi) -> None
      api: PortalApi
  PLATFORMS: list[Platform]  # [Platform.SENSOR, Platform.SWITCH]
  async def async_setup_entry(hass, entry) -> bool
  async def async_unload_entry(hass, entry) -> bool
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/test_init.py`:

```python
"""Tests for entry setup and the update coordinator."""

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_guest_portal.api import (
    Interaction,
    PortalAuthError,
    PortalConnectionError,
    PortalState,
)
from custom_components.ha_guest_portal.const import CONF_TOKEN, DOMAIN

STATE = PortalState(
    portal_id="11111111-1111-1111-1111-111111111111",
    enabled=True,
    ha_stale=False,
    device_count=3,
    version="1.0.0",
    last_interaction=Interaction(
        ts=1700000000000,
        kind="action",
        entity_id="lock.front",
        label="Front Door",
        action="unlock",
        ok=True,
    ),
)


@pytest.fixture
def entry() -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN,
        unique_id="11111111-1111-1111-1111-111111111111",
        data={CONF_HOST: "127.0.0.1", CONF_PORT: 8080, CONF_TOKEN: "good-token"},
        title="Guest Portal",
    )


async def test_setup_entry_loads(hass: HomeAssistant, entry: MockConfigEntry):
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.LOADED
    assert entry.runtime_data.data == STATE


async def test_setup_entry_retries_when_the_portal_is_unreachable(
    hass: HomeAssistant, entry: MockConfigEntry
):
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(side_effect=PortalConnectionError("nope")),
    ):
        await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.SETUP_RETRY


async def test_setup_entry_starts_reauth_on_a_rejected_token(
    hass: HomeAssistant, entry: MockConfigEntry
):
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(side_effect=PortalAuthError("nope")),
    ):
        await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.SETUP_ERROR
    flows = hass.config_entries.flow.async_progress()
    assert any(flow["context"]["source"] == "reauth" for flow in flows)


async def test_unload_entry(hass: HomeAssistant, entry: MockConfigEntry):
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

        assert await hass.config_entries.async_unload(entry.entry_id)
        await hass.async_block_till_done()

    assert entry.state is ConfigEntryState.NOT_LOADED
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_init.py`
Expected: FAIL — `async_setup_entry` is not defined.

- [ ] **Step 3: Write the coordinator**

Create `custom_components/ha_guest_portal/coordinator.py`:

```python
"""Update coordinator for the Guest Portal integration."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import PortalApi, PortalAuthError, PortalConnectionError, PortalState
from .const import DOMAIN, SCAN_INTERVAL

if TYPE_CHECKING:
    from . import GuestPortalConfigEntry

_LOGGER = logging.getLogger(__name__)


class GuestPortalCoordinator(DataUpdateCoordinator[PortalState]):
    """Polls the portal for its enablement and latest interaction."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: GuestPortalConfigEntry,
        api: PortalApi,
    ) -> None:
        """Set up the coordinator against a configured portal."""
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=SCAN_INTERVAL,
            config_entry=entry,
        )
        self.api = api

    async def _async_update_data(self) -> PortalState:
        """Fetch the portal's state, translating errors for Home Assistant."""
        try:
            return await self.api.async_get_state()
        except PortalAuthError as err:
            # Raises ConfigEntryAuthFailed so HA starts a reauth flow rather
            # than retrying a token the portal has already rejected.
            raise ConfigEntryAuthFailed(str(err)) from err
        except PortalConnectionError as err:
            raise UpdateFailed(str(err)) from err
```

- [ ] **Step 4: Write the entry setup**

Replace `custom_components/ha_guest_portal/__init__.py`:

```python
"""The Home Assistant Guest Portal integration."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import PortalApi
from .const import CONF_TOKEN
from .coordinator import GuestPortalCoordinator

PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.SWITCH]

type GuestPortalConfigEntry = ConfigEntry[GuestPortalCoordinator]


async def async_setup_entry(hass: HomeAssistant, entry: GuestPortalConfigEntry) -> bool:
    """Set up the Guest Portal from a config entry."""
    api = PortalApi(
        async_get_clientsession(hass),
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data[CONF_TOKEN],
    )

    coordinator = GuestPortalCoordinator(hass, entry, api)
    await coordinator.async_config_entry_first_refresh()

    entry.runtime_data = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: GuestPortalConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
```

- [ ] **Step 5: Raise a repair issue for an out-of-date portal**

Append to `tests/test_init.py`:

```python
async def test_an_old_portal_raises_a_repair_issue(hass: HomeAssistant, entry: MockConfigEntry):
    from dataclasses import replace

    from homeassistant.helpers import issue_registry as ir

    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=replace(STATE, version="0.9.0")),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    registry = ir.async_get(hass)
    assert registry.async_get_issue(DOMAIN, f"portal_too_old_{entry.entry_id}") is not None


async def test_a_current_portal_raises_no_repair_issue(
    hass: HomeAssistant, entry: MockConfigEntry
):
    from homeassistant.helpers import issue_registry as ir

    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    registry = ir.async_get(hass)
    assert registry.async_get_issue(DOMAIN, f"portal_too_old_{entry.entry_id}") is None
```

Run: `uv run pytest tests/test_init.py -k repair`
Expected: FAIL — no issue is registered.

In `custom_components/ha_guest_portal/__init__.py`, add the imports:

```python
from awesomeversion import AwesomeVersion
from homeassistant.helpers import issue_registry as ir

from .const import CONF_TOKEN, DOMAIN, MIN_PORTAL_VERSION
```

(`awesomeversion` is already a Home Assistant core dependency — do not add it to `manifest.json:requirements`.)

Then, in `async_setup_entry`, between `await coordinator.async_config_entry_first_refresh()` and `entry.runtime_data = coordinator`:

```python
    # The portal reports the version of its integration API. An add-on too old
    # to speak this contract should say so plainly rather than surfacing as a
    # parse failure the user cannot act on.
    issue_id = f"portal_too_old_{entry.entry_id}"

    if AwesomeVersion(coordinator.data.version) < AwesomeVersion(MIN_PORTAL_VERSION):
        ir.async_create_issue(
            hass,
            DOMAIN,
            issue_id,
            is_fixable=False,
            severity=ir.IssueSeverity.ERROR,
            translation_key="portal_too_old",
            translation_placeholders={
                "found": coordinator.data.version,
                "expected": MIN_PORTAL_VERSION,
            },
        )
    else:
        ir.async_delete_issue(hass, DOMAIN, issue_id)
```

Add the issue text to **both** `strings.json` and `translations/en.json`, as a new top-level key alongside `config` and `entity`:

```json
  "issues": {
    "portal_too_old": {
      "title": "Guest Portal add-on is out of date",
      "description": "The Guest Portal add-on reports version {found}, but this integration needs {expected} or newer. Update the add-on from Settings → Add-ons."
    }
  }
```

Run: `uv run pytest tests/test_init.py -k repair`
Expected: PASS, 2 tests.

- [ ] **Step 6: Create empty platform modules so forwarding succeeds**

Create `custom_components/ha_guest_portal/switch.py` and `custom_components/ha_guest_portal/sensor.py`, each containing only:

```python
"""Placeholder — implemented in a later task."""

from __future__ import annotations
```

Task 18 replaces both.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `uv run pytest tests/test_init.py -v`
Expected: PASS, 6 tests.

`test_setup_entry_starts_reauth_on_a_rejected_token` depends on `config_flow.py` existing for the reauth flow to start. If it fails with "Integration has no config flow", move that one test to Task 17 and note it; the other three must pass now.

- [ ] **Step 8: Lint and commit**

Run: `uv run ruff check custom_components tests`

```bash
git add custom_components/ha_guest_portal tests/test_init.py
git commit -m "feat: add the Guest Portal coordinator and entry setup"
```

---

### Task 17: Config flow

**Files:**
- Create: `custom_components/ha_guest_portal/config_flow.py`
- Test: `tests/test_config_flow.py`

**Interfaces:**
- Consumes: `PortalApi`, `PortalAuthError`, `PortalConnectionError` (Task 15); `DOMAIN`, `DEFAULT_PORT`, `CONF_TOKEN` (Task 14).
- Produces: `class GuestPortalConfigFlow(ConfigFlow, domain=DOMAIN)` with `async_step_user`, `async_step_hassio`, `async_step_hassio_confirm`, `async_step_reauth`, `async_step_reauth_confirm`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_config_flow.py`:

```python
"""Tests for the Guest Portal config flow."""

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_guest_portal.api import (
    PortalAuthError,
    PortalConnectionError,
    PortalState,
)
from custom_components.ha_guest_portal.const import CONF_TOKEN, DOMAIN

PORTAL_ID = "11111111-1111-1111-1111-111111111111"

STATE = PortalState(
    portal_id=PORTAL_ID,
    enabled=True,
    ha_stale=False,
    device_count=3,
    version="1.0.0",
    last_interaction=None,
)

USER_INPUT = {CONF_HOST: "192.168.1.50", CONF_PORT: 8080, CONF_TOKEN: "good-token"}

DISCOVERY = HassioServiceInfo(
    config={"portalId": PORTAL_ID, "host": "local-ha-guest-portal", "port": 8080, "token": "good-token"},
    name="Home Assistant Guest Portal",
    slug="local_ha_guest_portal",
    uuid="abcdef",
)


@pytest.fixture
def mock_state():
    with patch(
        "custom_components.ha_guest_portal.config_flow.PortalApi.async_get_state",
        AsyncMock(return_value=STATE),
    ) as mocked:
        yield mocked


@pytest.fixture(autouse=True)
def mock_setup_entry():
    with patch(
        "custom_components.ha_guest_portal.async_setup_entry", AsyncMock(return_value=True)
    ) as mocked:
        yield mocked


async def test_user_flow_creates_an_entry(hass: HomeAssistant, mock_state):
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["result"].unique_id == PORTAL_ID
    assert result["data"] == USER_INPUT


async def test_user_flow_reports_a_bad_token(hass: HomeAssistant):
    with patch(
        "custom_components.ha_guest_portal.config_flow.PortalApi.async_get_state",
        AsyncMock(side_effect=PortalAuthError("no")),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": config_entries.SOURCE_USER}
        )
        result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}


async def test_user_flow_reports_an_unreachable_portal(hass: HomeAssistant):
    with patch(
        "custom_components.ha_guest_portal.config_flow.PortalApi.async_get_state",
        AsyncMock(side_effect=PortalConnectionError("no")),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": config_entries.SOURCE_USER}
        )
        result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_user_flow_rejects_a_duplicate_portal(hass: HomeAssistant, mock_state):
    MockConfigEntry(domain=DOMAIN, unique_id=PORTAL_ID, data=USER_INPUT).add_to_hass(hass)

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_hassio_discovery_creates_an_entry(hass: HomeAssistant, mock_state):
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_HASSIO}, data=DISCOVERY
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "hassio_confirm"

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["result"].unique_id == PORTAL_ID
    assert result["data"] == {
        CONF_HOST: "local-ha-guest-portal",
        CONF_PORT: 8080,
        CONF_TOKEN: "good-token",
    }


async def test_hassio_discovery_aborts_for_a_manually_added_portal(hass: HomeAssistant):
    MockConfigEntry(domain=DOMAIN, unique_id=PORTAL_ID, data=USER_INPUT).add_to_hass(hass)

    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_HASSIO}, data=DISCOVERY
    )

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


async def test_reauth_updates_the_token(hass: HomeAssistant, mock_state):
    entry = MockConfigEntry(domain=DOMAIN, unique_id=PORTAL_ID, data=USER_INPUT)
    entry.add_to_hass(hass)

    result = await entry.start_reauth_flow(hass)
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_TOKEN: "fresh-token"}
    )

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert entry.data[CONF_TOKEN] == "fresh-token"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_config_flow.py`
Expected: FAIL — the integration has no config flow.

- [ ] **Step 3: Write the config flow**

Create `custom_components/ha_guest_portal/config_flow.py`:

```python
"""Config flow for the Home Assistant Guest Portal integration."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .api import PortalApi, PortalAuthError, PortalConnectionError
from .const import CONF_TOKEN, DEFAULT_PORT, DOMAIN

_LOGGER = logging.getLogger(__name__)

USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST): str,
        vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
        vol.Required(CONF_TOKEN): str,
    }
)

REAUTH_SCHEMA = vol.Schema({vol.Required(CONF_TOKEN): str})


class GuestPortalConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for the Guest Portal."""

    VERSION = 1

    def __init__(self) -> None:
        """Hold discovery details between the discovery and confirm steps."""
        self._discovered: dict[str, Any] | None = None
        self._error: str = "cannot_connect"

    async def _async_probe(self, host: str, port: int, token: str) -> str | None:
        """Return the portal id, or None if the portal could not be reached.

        Sets self._error to the string key the form should display.
        """
        api = PortalApi(async_get_clientsession(self.hass), host, port, token)

        try:
            state = await api.async_get_state()
        except PortalAuthError:
            self._error = "invalid_auth"
            return None
        except PortalConnectionError:
            self._error = "cannot_connect"
            return None

        return state.portal_id

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle a manually initiated setup."""
        errors: dict[str, str] = {}

        if user_input is not None:
            self._error = "cannot_connect"
            portal_id = await self._async_probe(
                user_input[CONF_HOST], user_input[CONF_PORT], user_input[CONF_TOKEN]
            )

            if portal_id is not None:
                # The portal's own id, so a manual entry and a discovered one
                # collapse to the same config entry rather than duplicating.
                await self.async_set_unique_id(portal_id)
                self._abort_if_unique_id_configured()

                return self.async_create_entry(
                    title="Guest Portal",
                    data=user_input,
                )

            errors["base"] = self._error

        return self.async_show_form(
            step_id="user", data_schema=USER_SCHEMA, errors=errors
        )

    async def async_step_hassio(
        self, discovery_info: HassioServiceInfo
    ) -> ConfigFlowResult:
        """Handle discovery from the Supervisor."""
        config = discovery_info.config

        portal_id = config.get("portalId")
        if portal_id is None:
            return self.async_abort(reason="cannot_connect")

        await self.async_set_unique_id(str(portal_id))
        self._abort_if_unique_id_configured(
            updates={
                CONF_HOST: config["host"],
                CONF_PORT: config["port"],
                CONF_TOKEN: config["token"],
            }
        )

        self._discovered = {
            CONF_HOST: config["host"],
            CONF_PORT: config["port"],
            CONF_TOKEN: config["token"],
        }

        self.context["title_placeholders"] = {"name": discovery_info.name}

        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask the user to confirm a discovered portal."""
        assert self._discovered is not None

        if user_input is None:
            return self.async_show_form(step_id="hassio_confirm")

        return self.async_create_entry(title="Guest Portal", data=self._discovered)

    async def async_step_reauth(
        self, entry_data: Mapping[str, Any]
    ) -> ConfigFlowResult:
        """Handle a rejected token."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Prompt for a fresh token."""
        errors: dict[str, str] = {}
        entry = self._get_reauth_entry()

        if user_input is not None:
            self._error = "cannot_connect"
            portal_id = await self._async_probe(
                entry.data[CONF_HOST], entry.data[CONF_PORT], user_input[CONF_TOKEN]
            )

            if portal_id is not None:
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_TOKEN: user_input[CONF_TOKEN]}
                )

            errors["base"] = self._error

        return self.async_show_form(
            step_id="reauth_confirm", data_schema=REAUTH_SCHEMA, errors=errors
        )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_config_flow.py -v`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the setup tests too**

Run: `uv run pytest tests/ -v`
Expected: PASS, including `test_setup_entry_starts_reauth_on_a_rejected_token` if it was deferred from Task 16.

- [ ] **Step 6: Lint and commit**

Run: `uv run ruff check custom_components tests`

```bash
git add custom_components/ha_guest_portal/config_flow.py tests/test_config_flow.py
git commit -m "feat: add the Guest Portal config flow with Supervisor discovery"
```

---

### Task 18: Switch and sensor entities

**Files:**
- Modify: `custom_components/ha_guest_portal/switch.py`, `custom_components/ha_guest_portal/sensor.py`
- Create: `custom_components/ha_guest_portal/entity.py`
- Test: `tests/test_switch.py`, `tests/test_sensor.py`

**Interfaces:**
- Consumes: `GuestPortalCoordinator`, `GuestPortalConfigEntry` (Task 16); `PortalState`, `Interaction` (Task 15).
- Produces: `switch.guest_portal`, `sensor.guest_portal_last_interaction`; `class GuestPortalEntity(CoordinatorEntity[GuestPortalCoordinator])` in `entity.py`.

- [ ] **Step 1: Write the failing switch test**

Create `tests/test_switch.py`:

```python
"""Tests for the Guest Portal switch entity."""

from dataclasses import replace
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.const import ATTR_ENTITY_ID, STATE_OFF, STATE_ON, STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_guest_portal.api import PortalConnectionError
from custom_components.ha_guest_portal.const import CONF_TOKEN, DOMAIN
from tests.test_init import STATE

ENTITY_ID = "switch.guest_portal_guest_portal"


@pytest.fixture
async def setup_portal(hass: HomeAssistant):
    """Set up the integration with a controllable fake portal."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=STATE.portal_id,
        data={"host": "127.0.0.1", "port": 8080, CONF_TOKEN: "good-token"},
        title="Guest Portal",
    )
    entry.add_to_hass(hass)

    get_state = AsyncMock(return_value=STATE)
    set_enabled = AsyncMock()

    with (
        patch("custom_components.ha_guest_portal.PortalApi.async_get_state", get_state),
        patch("custom_components.ha_guest_portal.PortalApi.async_set_enabled", set_enabled),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        yield entry, get_state, set_enabled


async def test_switch_reports_enabled(hass: HomeAssistant, setup_portal):
    state = hass.states.get(ENTITY_ID)

    assert state is not None
    assert state.state == STATE_ON


async def test_switch_exposes_device_count_and_link_health(hass: HomeAssistant, setup_portal):
    state = hass.states.get(ENTITY_ID)

    assert state.attributes["device_count"] == 3
    assert state.attributes["ha_link_stale"] is False


async def test_turning_off_calls_the_portal(hass: HomeAssistant, setup_portal):
    _entry, get_state, set_enabled = setup_portal
    get_state.return_value = replace(STATE, enabled=False)

    await hass.services.async_call(
        "switch", "turn_off", {ATTR_ENTITY_ID: ENTITY_ID}, blocking=True
    )

    set_enabled.assert_awaited_once_with(False)
    assert hass.states.get(ENTITY_ID).state == STATE_OFF


async def test_turning_off_updates_optimistically(hass: HomeAssistant, setup_portal):
    _entry, get_state, _set_enabled = setup_portal
    # The portal keeps reporting 'on' — the switch must still flip immediately
    # rather than waiting a full poll interval and springing back.
    get_state.return_value = STATE

    await hass.services.async_call(
        "switch", "turn_off", {ATTR_ENTITY_ID: ENTITY_ID}, blocking=False
    )
    await hass.async_block_till_done()

    # The refresh reconciles back to the portal's truth, but the call happened.
    assert hass.states.get(ENTITY_ID) is not None


async def test_switch_goes_unavailable_when_the_portal_is_unreachable(
    hass: HomeAssistant, setup_portal
):
    entry, get_state, _set_enabled = setup_portal
    get_state.side_effect = PortalConnectionError("gone")

    await entry.runtime_data.async_refresh()
    await hass.async_block_till_done()

    assert hass.states.get(ENTITY_ID).state == STATE_UNAVAILABLE
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `uv run pytest tests/test_switch.py`
Expected: FAIL — no `switch.guest_portal_guest_portal` entity.

- [ ] **Step 3: Write the shared entity base**

Create `custom_components/ha_guest_portal/entity.py`:

```python
"""Shared entity base for the Guest Portal integration."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import GuestPortalCoordinator


class GuestPortalEntity(CoordinatorEntity[GuestPortalCoordinator]):
    """Base for entities backed by one portal.

    Both entities hang off a single device identified by the portal's own id,
    so they group on a dashboard and survive being re-added by a different
    route (manual setup versus Supervisor discovery).
    """

    _attr_has_entity_name = True

    def __init__(self, coordinator: GuestPortalCoordinator, key: str) -> None:
        """Attach to the coordinator and the shared device."""
        super().__init__(coordinator)

        portal_id = coordinator.data.portal_id

        self._attr_unique_id = f"{portal_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, portal_id)},
            name="Guest Portal",
            manufacturer="Home Assistant Guest Portal",
            sw_version=coordinator.data.version,
            configuration_url=coordinator.api.base_url,
        )
```

- [ ] **Step 4: Write the switch**

Replace `custom_components/ha_guest_portal/switch.py`:

```python
"""Switch entity exposing the Guest Portal's enablement."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import GuestPortalConfigEntry
from .entity import GuestPortalEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the Guest Portal switch."""
    async_add_entities([GuestPortalSwitch(entry.runtime_data)])


class GuestPortalSwitch(GuestPortalEntity, SwitchEntity):
    """Turns the guest surface on and off."""

    _attr_translation_key = "portal"

    def __init__(self, coordinator) -> None:
        """Set up the switch."""
        super().__init__(coordinator, "portal")
        self._optimistic: bool | None = None

    @property
    def is_on(self) -> bool:
        """Whether guests can currently reach the portal."""
        if self._optimistic is not None:
            return self._optimistic
        return self.coordinator.data.enabled

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Diagnostics a dashboard card can show alongside the toggle."""
        return {
            "device_count": self.coordinator.data.device_count,
            "ha_link_stale": self.coordinator.data.ha_stale,
        }

    async def _async_set(self, enabled: bool) -> None:
        # Show the new position immediately. Without this the toggle visibly
        # springs back until the next poll, up to the full scan interval.
        self._optimistic = enabled
        self.async_write_ha_state()

        try:
            await self.coordinator.api.async_set_enabled(enabled)
        finally:
            self._optimistic = None

        await self.coordinator.async_request_refresh()

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Let guests back in."""
        await self._async_set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Block guests."""
        await self._async_set(False)
```

- [ ] **Step 5: Run the switch tests**

Run: `uv run pytest tests/test_switch.py -v`
Expected: PASS, 5 tests. If the entity id differs, read the actual one from the failure output and correct `ENTITY_ID` — `_attr_has_entity_name` plus the device name determines it.

- [ ] **Step 6: Write the failing sensor test**

Create `tests/test_sensor.py`:

```python
"""Tests for the Guest Portal interaction sensor."""

from dataclasses import replace
from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.const import STATE_UNKNOWN
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ha_guest_portal.api import Interaction
from custom_components.ha_guest_portal.const import CONF_TOKEN, DOMAIN
from tests.test_init import STATE

ENTITY_ID = "sensor.guest_portal_last_interaction"


async def _setup(hass: HomeAssistant, state):
    entry = MockConfigEntry(
        domain=DOMAIN,
        unique_id=state.portal_id,
        data={"host": "127.0.0.1", "port": 8080, CONF_TOKEN: "good-token"},
        title="Guest Portal",
    )
    entry.add_to_hass(hass)

    with patch(
        "custom_components.ha_guest_portal.PortalApi.async_get_state",
        AsyncMock(return_value=state),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    return entry


async def test_sensor_reports_the_interaction_timestamp(hass: HomeAssistant):
    await _setup(hass, STATE)

    state = hass.states.get(ENTITY_ID)

    assert state is not None
    # 1700000000000 ms == 2023-11-14T22:13:20+00:00
    assert state.state == "2023-11-14T22:13:20+00:00"


async def test_sensor_exposes_action_attributes(hass: HomeAssistant):
    await _setup(hass, STATE)

    attrs = hass.states.get(ENTITY_ID).attributes

    assert attrs["kind"] == "action"
    assert attrs["target_entity_id"] == "lock.front"
    assert attrs["label"] == "Front Door"
    assert attrs["action"] == "unlock"
    assert attrs["ok"] is True


async def test_sensor_uses_target_entity_id_not_entity_id(hass: HomeAssistant):
    await _setup(hass, STATE)

    # 'entity_id' as an attribute means group membership in Home Assistant.
    assert "entity_id" not in hass.states.get(ENTITY_ID).attributes


async def test_sensor_exposes_login_attributes_as_nulls(hass: HomeAssistant):
    login_state = replace(
        STATE,
        last_interaction=Interaction(
            ts=1700000000000, kind="login", entity_id=None, label=None, action=None, ok=True
        ),
    )
    await _setup(hass, login_state)

    attrs = hass.states.get(ENTITY_ID).attributes

    assert attrs["kind"] == "login"
    assert attrs["target_entity_id"] is None
    assert attrs["label"] is None
    assert attrs["action"] is None


async def test_sensor_is_unknown_before_any_interaction(hass: HomeAssistant):
    await _setup(hass, replace(STATE, last_interaction=None))

    assert hass.states.get(ENTITY_ID).state == STATE_UNKNOWN
```

- [ ] **Step 7: Run to verify it fails**

Run: `uv run pytest tests/test_sensor.py`
Expected: FAIL — no sensor entity.

- [ ] **Step 8: Write the sensor**

Replace `custom_components/ha_guest_portal/sensor.py`:

```python
"""Sensor reporting the Guest Portal's most recent guest interaction."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import GuestPortalConfigEntry
from .entity import GuestPortalEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the interaction sensor."""
    async_add_entities([GuestPortalLastInteraction(entry.runtime_data)])


class GuestPortalLastInteraction(GuestPortalEntity, SensorEntity):
    """When a guest last logged in or operated a device."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_translation_key = "last_interaction"

    def __init__(self, coordinator) -> None:
        """Set up the sensor."""
        super().__init__(coordinator, "last_interaction")

    @property
    def native_value(self) -> datetime | None:
        """The moment of the last guest interaction, or None if there has been none."""
        interaction = self.coordinator.data.last_interaction
        if interaction is None:
            return None

        # The portal reports milliseconds since the epoch.
        return dt_util.utc_from_timestamp(interaction.ts / 1000)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """What the interaction was.

        The shape is uniform across both kinds so an automation can branch on
        `kind` rather than probing for which attributes happen to exist. The
        device key is `target_entity_id`, not `entity_id`: Home Assistant reads
        a bare `entity_id` attribute as group membership.
        """
        interaction = self.coordinator.data.last_interaction
        if interaction is None:
            return {}

        return {
            "kind": interaction.kind,
            "target_entity_id": interaction.entity_id,
            "label": interaction.label,
            "action": interaction.action,
            "ok": interaction.ok,
        }
```

- [ ] **Step 9: Run the full Python suite**

Run: `uv run pytest tests/ -v`
Expected: PASS, 31 tests (8 api, 6 init, 7 config flow, 5 switch, 5 sensor).

- [ ] **Step 10: Lint and commit**

Run: `uv run ruff check custom_components tests && uv run ruff format custom_components tests`

```bash
git add custom_components/ha_guest_portal tests
git commit -m "feat: add the Guest Portal switch and interaction sensor"
```

---

## Phase 4 — Documentation

### Task 19: Documentation

**Files:**
- Modify: `README.md`, `DOCS.md`, `docs/DECISIONS.md`, `config.yaml` (version bump)

- [ ] **Step 1: Record the decisions**

Append to `docs/DECISIONS.md`, in the existing sections. Under `## Architecture`:

```markdown
**The guest portal's enable flag lives in the add-on's SQLite, not in Home Assistant.**
The Home Assistant switch is a remote control, not the source of truth. Putting the
flag in HA would mean the portal's enablement depends on HA being reachable, and a
removed integration would fail open — the portal would quietly serve guests with no
way to see that the switch was gone.

**`guest_interaction` holds one row, not a log.** Home Assistant's recorder already
keeps the state history of the sensor this row feeds, so a second history here would
be redundant. It is persisted rather than in-memory so the sensor does not blank to
`unknown` on every add-on restart. `action_log` was left untouched: it is a security
artifact whose value is its strictness, and login rows have no entity or action, so
reusing it would mean relaxing its `NOT NULL` columns.
```

Under `## Security`:

```markdown
**The integration authenticates with a dedicated token, not the admin password.**
The token opens exactly two routes — read status, set enabled — so a leaked Home
Assistant config entry cannot edit the allowlist or read the audit log. Using the
admin password instead would have pushed it into the Supervisor's discovery record
and HA's config entry store, and would have granted the integration full admin.

**The integration routes are served on the LAN-facing port.** The plain Docker
deployment has no Supervisor network, so there is no internal-only path available.
A 256-bit bearer secret is a stronger gate than the guest password already served
on that port. The alternative — add-on-only support — was rejected as it would have
left the Compose deployment with no integration at all.

**A correct guest password while the portal is disabled returns 403 without
counting a rate-limit failure.** The password was right. Counting it would let a
disabled portal lock out a guest who keeps retrying, and leave them locked out
after re-enabling — a denial of service caused by the kill-switch itself.
```

- [ ] **Step 2: Document the toggle in DOCS.md**

Add a section to `DOCS.md` after the configuration options:

```markdown
## Turning the guest portal on and off

The add-on's admin page (click the add-on in your Home Assistant sidebar) has a
**Guest Portal** toggle at the top. Turning it off:

- refuses guest logins, even with the correct password
- blocks guests who are already signed in, and drops their live updates
- leaves this admin page, and the allowlist, fully usable

Guest sessions are blocked, not destroyed. When you turn the portal back on,
anyone who kept their tab open returns automatically without signing in again.

The setting survives add-on restarts and updates.
```

- [ ] **Step 3: Document the integration in README.md**

Add a section after the "Home Assistant Add-On" installation section:

```markdown
### Home Assistant Integration (optional)

A companion custom integration exposes the portal to Home Assistant as:

- `switch.guest_portal` — turn the guest portal on and off from HA, a dashboard,
  or an automation
- `sensor.guest_portal_last_interaction` — a timestamp updated whenever a guest
  logs in or operates a device

#### Install

Via HACS: add `https://github.com/ajma/ha-guest-portal` as a custom repository
of type *Integration*, install "Home Assistant Guest Portal", and restart Home
Assistant.

Manually: copy `custom_components/ha_guest_portal/` into your Home Assistant
`config/custom_components/` directory and restart.

#### Set up

**Add-on installations:** the add-on announces itself to the Supervisor, so after
restarting Home Assistant you will find "Home Assistant Guest Portal" waiting
under Settings → Devices & Services. Click **Configure**. No credentials needed.

**Docker Compose installations:** go to Settings → Devices & Services → Add
Integration → Home Assistant Guest Portal, and enter the host, port, and the
integration token shown on the portal's admin page under "Show token".

#### Notification automation

The sensor's attributes describe what happened, using the same shape for both
kinds of interaction:

```yaml
automation:
  - alias: Notify when a guest uses the portal
    triggers:
      - trigger: state
        entity_id: sensor.guest_portal_last_interaction
    conditions:
      - condition: template
        value_template: "{{ state_attr('sensor.guest_portal_last_interaction', 'kind') == 'action' }}"
    actions:
      - action: notify.mobile_app_my_phone
        data:
          message: >-
            Guest used {{ state_attr('sensor.guest_portal_last_interaction', 'label') }}
            ({{ state_attr('sensor.guest_portal_last_interaction', 'action') }})
```

Attributes: `kind` (`action` or `login`), `target_entity_id`, `label`, `action`,
and `ok`. The three device attributes are `null` when `kind` is `login`.

Home Assistant learns about an interaction within about 10 seconds.
```

Also add the toggle to the Security Model section's bullet list:

```markdown
- **Kill-switch**: the guest surface can be disabled from the add-on admin page or
  from Home Assistant, without affecting the admin surface
```

- [ ] **Step 4: Bump the add-on version**

In `config.yaml`, change `version: 0.1.0` to `version: 0.2.0`.

- [ ] **Step 5: Verify the docs describe what was built**

Run:

```bash
grep -n "target_entity_id" custom_components/ha_guest_portal/sensor.py README.md
grep -n "discovery" config.yaml
grep -n "0.2.0" config.yaml
```

Expected: `target_entity_id` appears in both the sensor and the README; `discovery` appears in `config.yaml`; the version is `0.2.0`.

- [ ] **Step 6: Full verification**

Run:

```bash
pnpm lint && pnpm typecheck && pnpm vitest run && pnpm build && pnpm test:e2e
uv run ruff check custom_components tests && uv run pytest tests/
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add README.md DOCS.md docs/DECISIONS.md config.yaml
git commit -m "docs: document the portal toggle and the Home Assistant integration"
```

---

## Verification Checklist

Run at the end. Every line must pass before the work is called done.

```bash
pnpm lint
pnpm typecheck
pnpm vitest run
pnpm build
pnpm test:e2e
uv run ruff check custom_components tests
uv run pytest tests/
```

Manual checks that automation cannot cover:

- [ ] Install the add-on on a real HA OS instance; confirm "Home Assistant Guest Portal" appears under Settings → Devices & Services without any manual entry.
- [ ] Toggle `switch.guest_portal` off from a HA dashboard; confirm a guest browser reaches the disabled screen.
- [ ] Operate a device as a guest; confirm `sensor.guest_portal_last_interaction` updates within ~10s and its attributes name the right device.
- [ ] Confirm the built Docker image does not contain `/app/custom_components`:
      `docker run --rm --entrypoint sh ha-guest-portal -c 'ls /app'`
