# Multi-Portal Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support more than one guest portal per deployment — each with its own password, title, theme, enablement, and device allowlist — with one admin identity able to view, edit, and switch between all of them, and the Home Assistant integration exposing one switch + one sensor per portal.

**Architecture:** One Node/Hono process, one SQLite database, one Home Assistant WebSocket connection continue to serve every portal. What were global singletons (allowlist, audit log, interaction log, title/theme/enabled) become rows scoped by a new `portal_id`, joined per-request or per-SSE-connection against the one shared HA state cache. Login resolves a password to either the admin role or a specific portal's guest role. The HA custom integration's one config entry grows a coordinator that tracks a *list* of portals and dynamically creates/removes entity pairs.

**Tech Stack:** TypeScript (Node, Hono, Zod, `node:sqlite`), React (web client), Python (Home Assistant custom integration, `pytest-homeassistant-custom-component`).

**Spec:** `docs/superpowers/specs/2026-09-20-multi-portal-design.md`

## Global Constraints

- No migration path. This is a breaking schema change; the SQLite database must be deleted before running a build with this change (spec Non-goals).
- Password storage stays SHA-256 + timing-safe-compare, not salted/hashed-at-rest (spec Non-goals / Accepted risks).
- Version numbers (`package.json`, `config.yaml`, `manifest.json`) are not to be bumped as part of this plan unless the project owner explicitly instructs it (standing project rule, established this session).
- No comments unless explaining non-obvious WHY; match existing code style exactly (see files quoted throughout this plan).
- TDD throughout: a task's test step must be run and observed to fail before its implementation step.
- Every task's diff must leave `pnpm lint` clean, and must leave clean whichever test files directly cover the task's own changed code (the "run to verify it passes" step each task specifies). `pnpm typecheck` and the *full* `pnpm vitest run`/`pytest` suite are expected clean at phase checkpoints, not after every individual task — Phase 1 (Tasks 1-5) deliberately changes the shared SQLite schema before every store consuming it is migrated, so the full suite is red by design between Task 1 and Task 5. The same applies to any later phase whose tasks share a not-yet-fully-migrated interface. Run the full suite at the end of each phase (already called out explicitly at the end of Tasks 15 and 25) and treat red there as a real gate.

---

## Phase 1: Data model

### Task 1: Portal table and `PortalStore`

**Files:**
- Modify: `src/server/store/db.ts` (full contents currently 51 lines — replace the `SCHEMA` constant)
- Create: `src/server/store/portals.ts`
- Test: `test/unit/portals.test.ts` (new)

**Interfaces:**
- Produces: `PortalStore` class with `list(): Portal[]`, `get(id: string): Portal | null`, `create(input: { title: string; password: string }): Portal`, `update(id: string, patch: { title?: string; theme?: ThemeId; enabled?: boolean; password?: string }): Portal`, `delete(id: string): void`, `findByPassword(password: string): Portal | null`, all on a `Portal` type `{ id: string; title: string; theme: ThemeId; enabled: boolean; password: string; createdAt: number }`. Throws `DuplicatePasswordError` (a new exported `class DuplicatePasswordError extends Error {}`) from `create`/`update` when the password collides with another portal's.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/portals.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../src/server/store/db.js'
import { PortalStore, DuplicatePasswordError } from '../../src/server/store/portals.js'

describe('PortalStore', () => {
  let db: DatabaseSync
  let store: PortalStore

  beforeEach(() => {
    db = openDb(':memory:')
    store = new PortalStore(db)
  })

  it('creates a portal with defaults and lists it', () => {
    const created = store.create({ title: 'Timothy', password: 'a-secret-1' })
    expect(created.title).toBe('Timothy')
    expect(created.enabled).toBe(true)
    expect(created.theme).toBe('classic')
    expect(typeof created.id).toBe('string')

    const listed = store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(created.id)
  })

  it('rejects a duplicate password on create', () => {
    store.create({ title: 'Timothy', password: 'shared-pass' })
    expect(() => store.create({ title: 'Mary', password: 'shared-pass' })).toThrow(
      DuplicatePasswordError,
    )
  })

  it('rejects a duplicate password on update, but allows keeping your own', () => {
    const a = store.create({ title: 'Timothy', password: 'pass-a' })
    const b = store.create({ title: 'Mary', password: 'pass-b' })

    expect(() => store.update(b.id, { password: 'pass-a' })).toThrow(DuplicatePasswordError)
    expect(() => store.update(a.id, { password: 'pass-a' })).not.toThrow()
  })

  it('finds a portal by its password', () => {
    const created = store.create({ title: 'Timothy', password: 'find-me' })
    expect(store.findByPassword('find-me')?.id).toBe(created.id)
    expect(store.findByPassword('wrong')).toBeNull()
  })

  it('updates title, theme, and enabled independently', () => {
    const created = store.create({ title: 'Timothy', password: 'a-secret-2' })
    const updated = store.update(created.id, { title: 'Tim', theme: 'tiles', enabled: false })
    expect(updated).toEqual({ ...created, title: 'Tim', theme: 'tiles', enabled: false })
  })

  it('deletes a portal', () => {
    const created = store.create({ title: 'Timothy', password: 'a-secret-3' })
    store.delete(created.id)
    expect(store.list()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/portals.test.ts`
Expected: FAIL — `Cannot find module '../../src/server/store/portals.js'`

- [ ] **Step 3: Replace `db.ts`'s schema**

Full new contents of `src/server/store/db.ts` (same file, same exported `openDb`, only the `SCHEMA` string changes):

```ts
// src/server/store/db.ts

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS portal (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  theme      TEXT NOT NULL,
  password   TEXT NOT NULL UNIQUE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exposed_device (
  entity_id       TEXT NOT NULL,
  portal_id       TEXT NOT NULL REFERENCES portal(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  allowed_actions TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (portal_id, entity_id)
);

CREATE TABLE IF NOT EXISTS action_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  portal_id TEXT NOT NULL REFERENCES portal(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  action    TEXT NOT NULL,
  role      TEXT NOT NULL,
  ok        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guest_interaction (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  portal_id TEXT NOT NULL REFERENCES portal(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  entity_id TEXT,
  label     TEXT,
  action    TEXT,
  ok        INTEGER NOT NULL
);
`

export function openDb(path: string): DatabaseSync {
  // Create parent directories if this is a file path (not :memory:)
  if (path !== ':memory:') {
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true })
  }

  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
```

Note the added `PRAGMA foreign_keys = ON` — SQLite does not enforce `REFERENCES ... ON DELETE CASCADE` unless foreign keys are turned on per-connection, and cascading delete is exactly what Task 6 (portal deletion) relies on.

- [ ] **Step 4: Write `PortalStore`**

```ts
// src/server/store/portals.ts
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from '../../shared/themes.js'

export class DuplicatePasswordError extends Error {
  constructor() {
    super('That password is already in use by another portal')
  }
}

export type Portal = {
  id: string
  title: string
  theme: ThemeId
  password: string
  enabled: boolean
  createdAt: number
}

const PortalRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  theme: z.string(),
  password: z.string(),
  enabled: z.number(),
  created_at: z.number(),
})

function rowToPortal(row: unknown): Portal | null {
  const parsed = PortalRowSchema.safeParse(row)
  if (!parsed.success) return null
  const { id, title, theme, password, enabled, created_at } = parsed.data
  return {
    id,
    title,
    theme: isThemeId(theme) ? theme : DEFAULT_THEME_ID,
    password,
    enabled: enabled === 1,
    createdAt: created_at,
  }
}

// SQLite's UNIQUE constraint on `portal.password` is the source of truth for
// portal-vs-portal collisions; this message is what node:sqlite raises for it.
function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('UNIQUE constraint failed: portal.password')
  )
}

export class PortalStore {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  list(): Portal[] {
    const rows = this.db
      .prepare('SELECT id, title, theme, password, enabled, created_at FROM portal ORDER BY created_at')
      .all()
    return rows.map(rowToPortal).filter((p): p is Portal => p !== null)
  }

  get(id: string): Portal | null {
    const row = this.db
      .prepare('SELECT id, title, theme, password, enabled, created_at FROM portal WHERE id = ?')
      .get(id)
    return row === undefined ? null : rowToPortal(row)
  }

  findByPassword(password: string): Portal | null {
    const row = this.db
      .prepare('SELECT id, title, theme, password, enabled, created_at FROM portal WHERE password = ?')
      .get(password)
    return row === undefined ? null : rowToPortal(row)
  }

  create(input: { title: string; password: string }): Portal {
    const id = randomUUID()
    const createdAt = Date.now()

    try {
      this.db
        .prepare(
          'INSERT INTO portal (id, title, theme, password, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
        )
        .run(id, input.title, DEFAULT_THEME_ID, input.password, createdAt)
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new DuplicatePasswordError()
      throw error
    }

    const created = this.get(id)
    if (created === null) throw new Error('Portal vanished immediately after creation')
    return created
  }

  update(
    id: string,
    patch: { title?: string; theme?: ThemeId; enabled?: boolean; password?: string },
  ): Portal {
    const current = this.get(id)
    if (current === null) throw new Error(`No portal with id ${id}`)

    const next = {
      title: patch.title ?? current.title,
      theme: patch.theme ?? current.theme,
      enabled: patch.enabled ?? current.enabled,
      password: patch.password ?? current.password,
    }

    try {
      this.db
        .prepare('UPDATE portal SET title = ?, theme = ?, enabled = ?, password = ? WHERE id = ?')
        .run(next.title, next.theme, next.enabled ? 1 : 0, next.password, id)
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new DuplicatePasswordError()
      throw error
    }

    const updated = this.get(id)
    if (updated === null) throw new Error(`Portal ${id} vanished during update`)
    return updated
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM portal WHERE id = ?').run(id)
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/portals.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean

- [ ] **Step 7: Commit**

```bash
git add src/server/store/db.ts src/server/store/portals.ts test/unit/portals.test.ts
git commit -m "feat: add the portal table and PortalStore"
```

### Task 2: `AllowlistStore` becomes portal-scoped

**Files:**
- Modify: `src/server/store/allowlist.ts` (full current contents 146 lines)
- Test: `test/unit/allowlist-store.test.ts` (new — no dedicated file exists today; today's coverage is indirect via `test/integration/routes-admin.test.ts`)

**Interfaces:**
- Consumes: nothing new.
- Produces: every method gains a leading `portalId: string` parameter: `list(portalId)`, `entityIds(portalId)`, `asMap(portalId)`, `replace(portalId, rows)`. `AllowlistChangeListener` becomes `(portalId: string, entityIds: string[]) => void` so `onChange` subscribers (Task 14) know which portal changed.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/allowlist-store.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../src/server/store/db.js'
import { PortalStore } from '../../src/server/store/portals.js'
import { AllowlistStore } from '../../src/server/store/allowlist.js'

describe('AllowlistStore (portal-scoped)', () => {
  let db: DatabaseSync
  let portals: PortalStore
  let store: AllowlistStore
  let timothy: string
  let mary: string

  beforeEach(() => {
    db = openDb(':memory:')
    portals = new PortalStore(db)
    store = new AllowlistStore(db)
    timothy = portals.create({ title: 'Timothy', password: 'pass-1' }).id
    mary = portals.create({ title: 'Mary', password: 'pass-2' }).id
  })

  it('keeps each portal\'s allowlist independent', () => {
    store.replace(timothy, [
      { entityId: 'light.timothy_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
    ])
    store.replace(mary, [
      { entityId: 'light.mary_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
    ])

    expect(store.list(timothy)).toHaveLength(1)
    expect(store.list(timothy)[0]?.entityId).toBe('light.timothy_room')
    expect(store.list(mary)[0]?.entityId).toBe('light.mary_room')
  })

  it('allows the same entity in more than one portal, independently configured', () => {
    store.replace(timothy, [
      { entityId: 'light.shared', label: 'Living Room', allowedActions: ['turn_on'], sortOrder: 0 },
    ])
    store.replace(mary, [
      {
        entityId: 'light.shared',
        label: 'Living Room',
        allowedActions: ['turn_on', 'turn_off'],
        sortOrder: 0,
      },
    ])

    expect(store.asMap(timothy).get('light.shared')).toEqual(['turn_on'])
    expect(store.asMap(mary).get('light.shared')).toEqual(['turn_on', 'turn_off'])
  })

  it('notifies onChange with the portal id that changed', () => {
    const seen: Array<{ portalId: string; entityIds: string[] }> = []
    store.onChange((portalId, entityIds) => seen.push({ portalId, entityIds }))

    store.replace(timothy, [
      { entityId: 'light.a', label: 'A', allowedActions: [], sortOrder: 0 },
    ])

    expect(seen).toEqual([{ portalId: timothy, entityIds: ['light.a'] }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/allowlist-store.test.ts`
Expected: FAIL — `store.replace` called with 2 args where the current signature takes 1, and `onChange` callback shape mismatch (TypeScript will also flag this at the call sites once Step 3 lands; run the test first to confirm the runtime shape is what's being exercised).

- [ ] **Step 3: Rewrite `allowlist.ts`**

Full new contents of `src/server/store/allowlist.ts`:

```ts
// src/server/store/allowlist.ts
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { AllowlistRow } from '../../shared/api.js'

export type AllowlistChangeListener = (portalId: string, entityIds: string[]) => void

const ExposedDeviceRowSchema = z.object({
  entity_id: z.string(),
  label: z.string(),
  allowed_actions: z.string(),
  sort_order: z.number(),
})

const EntityIdRowSchema = z.object({
  entity_id: z.string(),
})

export class AllowlistStore {
  private db: DatabaseSync
  private listeners: Set<AllowlistChangeListener> = new Set()

  constructor(db: DatabaseSync) {
    this.db = db
  }

  list(portalId: string): AllowlistRow[] {
    const rows = this.db
      .prepare(
        'SELECT entity_id, label, allowed_actions, sort_order FROM exposed_device WHERE portal_id = ? ORDER BY sort_order, entity_id',
      )
      .all(portalId)

    const result: AllowlistRow[] = []

    for (const row of rows) {
      const parsed = ExposedDeviceRowSchema.safeParse(row)
      if (!parsed.success) {
        continue
      }

      const { entity_id, label, allowed_actions, sort_order } = parsed.data

      let allowedActions: string[]
      try {
        const jsonParsed = JSON.parse(allowed_actions)
        allowedActions = Array.isArray(jsonParsed) ? jsonParsed : []
      } catch {
        console.error(
          `Corrupt allowed_actions JSON for entity ${entity_id}, failing closed with empty actions`,
        )
        allowedActions = []
      }

      result.push({
        entityId: entity_id,
        label,
        allowedActions,
        sortOrder: sort_order,
      })
    }

    return result
  }

  entityIds(portalId: string): string[] {
    const rows = this.db
      .prepare('SELECT entity_id FROM exposed_device WHERE portal_id = ? ORDER BY sort_order, entity_id')
      .all(portalId)

    const result: string[] = []

    for (const row of rows) {
      const parsed = EntityIdRowSchema.safeParse(row)
      if (!parsed.success) {
        continue
      }
      result.push(parsed.data.entity_id)
    }

    return result
  }

  asMap(portalId: string): Map<string, readonly string[]> {
    const rows = this.list(portalId)
    const map = new Map<string, readonly string[]>()

    for (const row of rows) {
      map.set(row.entityId, row.allowedActions)
    }

    return map
  }

  replace(portalId: string, rows: AllowlistRow[]): void {
    try {
      this.db.exec('BEGIN')

      this.db.prepare('DELETE FROM exposed_device WHERE portal_id = ?').run(portalId)

      const insert = this.db.prepare(
        'INSERT INTO exposed_device (portal_id, entity_id, label, allowed_actions, sort_order) VALUES (?, ?, ?, ?, ?)',
      )

      for (const row of rows) {
        insert.run(portalId, row.entityId, row.label, JSON.stringify(row.allowedActions), row.sortOrder)
      }

      this.db.exec('COMMIT')

      const entityIds = rows.map((r) => r.entityId)
      this.notifyListeners(portalId, entityIds)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  onChange(fn: AllowlistChangeListener): () => void {
    this.listeners.add(fn)

    let unsubscribed = false
    return () => {
      if (!unsubscribed) {
        this.listeners.delete(fn)
        unsubscribed = true
      }
    }
  }

  private notifyListeners(portalId: string, entityIds: string[]): void {
    for (const listener of this.listeners) {
      try {
        listener(portalId, entityIds)
      } catch {
        // Swallow errors to prevent one listener from breaking others
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/allowlist-store.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/store/allowlist.ts test/unit/allowlist-store.test.ts
git commit -m "feat: scope AllowlistStore to a portal"
```

Note: this task deliberately does **not** yet fix the call sites in `routes-guest.ts`/`routes-admin.ts`/`runtime.ts`/`useAllowlistEditor.ts` that call these methods with the old (pre-portal) argument count — those go red under `pnpm typecheck` until Tasks 10, 11, and 14 land. That is expected and acceptable mid-plan; do not attempt to silence it early by passing a placeholder portal id.

### Task 3: `AuditLog` becomes portal-scoped

**Files:**
- Modify: `src/server/store/auditlog.ts` (full current contents 62 lines)
- Test: `test/unit/audit-log.test.ts` (new — no dedicated file exists today)

**Interfaces:**
- Produces: `AuditEntry` gains `portalId: string`; `record(e: AuditEntry)` unchanged signature (portalId now required on the object); `recent(portalId: string, limit: number): AuditEntry[]` — scoped, so `portalId` becomes a required leading parameter.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/audit-log.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../../src/server/store/db.js'
import { PortalStore } from '../../src/server/store/portals.js'
import { AuditLog } from '../../src/server/store/auditlog.js'

describe('AuditLog (portal-scoped)', () => {
  let db: DatabaseSync
  let audit: AuditLog
  let timothy: string
  let mary: string

  beforeEach(() => {
    db = openDb(':memory:')
    const portals = new PortalStore(db)
    audit = new AuditLog(db)
    timothy = portals.create({ title: 'Timothy', password: 'pass-1' }).id
    mary = portals.create({ title: 'Mary', password: 'pass-2' }).id
  })

  it('keeps each portal\'s audit trail separate', () => {
    audit.record({ portalId: timothy, ts: 1, entityId: 'light.a', action: 'turn_on', role: 'guest', ok: true })
    audit.record({ portalId: mary, ts: 2, entityId: 'light.b', action: 'turn_on', role: 'guest', ok: true })

    expect(audit.recent(timothy, 10)).toHaveLength(1)
    expect(audit.recent(timothy, 10)[0]?.entityId).toBe('light.a')
    expect(audit.recent(mary, 10)[0]?.entityId).toBe('light.b')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/audit-log.test.ts`
Expected: FAIL — `portal_id` column / `portalId` field do not exist on the current type

- [ ] **Step 3: Rewrite `auditlog.ts`**

```ts
// src/server/store/auditlog.ts
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { Role } from '../../shared/api.js'

export type AuditEntry = {
  portalId: string
  ts: number
  entityId: string
  action: string
  role: Role
  ok: boolean
}

const ActionLogRowSchema = z.object({
  ts: z.number(),
  entity_id: z.string(),
  action: z.string(),
  role: z.enum(['guest', 'admin']),
  ok: z.number(),
})

export class AuditLog {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  record(e: AuditEntry): void {
    this.db
      .prepare(
        'INSERT INTO action_log (portal_id, ts, entity_id, action, role, ok) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(e.portalId, e.ts, e.entityId, e.action, e.role, e.ok ? 1 : 0)
  }

  recent(portalId: string, limit: number): Array<Omit<AuditEntry, 'portalId'>> {
    const rows = this.db
      .prepare(
        'SELECT ts, entity_id, action, role, ok FROM action_log WHERE portal_id = ? ORDER BY id DESC LIMIT ?',
      )
      .all(portalId, limit)

    const result: Array<Omit<AuditEntry, 'portalId'>> = []

    for (const row of rows) {
      const parsed = ActionLogRowSchema.safeParse(row)
      if (!parsed.success) {
        continue
      }

      const { ts, entity_id, action, role, ok } = parsed.data

      result.push({
        ts,
        entityId: entity_id,
        action,
        role,
        ok: ok === 1,
      })
    }

    return result
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/audit-log.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/store/auditlog.ts test/unit/audit-log.test.ts
git commit -m "feat: scope AuditLog to a portal"
```

### Task 4: `InteractionStore` becomes portal-scoped and append-only

**Files:**
- Modify: `src/server/store/interactions.ts` (full current contents 75 lines)
- Test: `test/unit/interactions.test.ts` (existing — extend it)

**Interfaces:**
- Produces: `GuestInteraction` gains `portalId: string`; `record(e: GuestInteraction)` unchanged signature; `latest(portalId: string): GuestInteraction | null` — now a required leading parameter, and "latest" means "most recent row for this portal" rather than "the one row."

- [ ] **Step 1: Write the failing test**

Read `test/unit/interactions.test.ts` first to match its existing style, then add:

```ts
it('keeps each portal\'s latest interaction separate and append-only', () => {
  const store = new InteractionStore(db)
  const timothy = 'portal-timothy'
  const mary = 'portal-mary'

  store.record({ portalId: timothy, ts: 1, kind: 'login', entityId: null, label: null, action: null, ok: true })
  store.record({ portalId: mary, ts: 2, kind: 'login', entityId: null, label: null, action: null, ok: true })
  store.record({ portalId: timothy, ts: 3, kind: 'action', entityId: 'light.a', label: 'A', action: 'turn_on', ok: true })

  expect(store.latest(timothy)?.ts).toBe(3)
  expect(store.latest(mary)?.ts).toBe(2)
})
```

(This test creates portals directly by string id rather than through `PortalStore`, since `guest_interaction.portal_id` has no foreign-key enforcement need for this unit test in isolation — if the existing test file's `beforeEach` already opens a `:memory:` db without seeding a `portal` table row, keep doing that; the FK constraint from Task 1 only fires if `PRAGMA foreign_keys = ON` finds no matching parent row, so this test needs either an existing portal row or a db opened before the FK pragma took effect. Check the existing test file's setup — if it fails on the foreign key, seed a portal row via `db.exec` first, e.g. `db.exec("INSERT INTO portal (id, title, theme, password, enabled, created_at) VALUES ('portal-timothy', 't', 'classic', 'p1', 1, 0), ('portal-mary', 'm', 'classic', 'p2', 1, 0)")`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/interactions.test.ts`
Expected: FAIL

- [ ] **Step 3: Rewrite `interactions.ts`**

```ts
// src/server/store/interactions.ts
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export type GuestInteraction = {
  portalId: string
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
 * Append-only per portal. Home Assistant's recorder keeps the state history of
 * the sensor fed by each portal's latest row, so a second history here would
 * be redundant — `latest()` is the only read this store needs to support.
 */
export class InteractionStore {
  private db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  record(e: GuestInteraction): void {
    this.db
      .prepare(
        `INSERT INTO guest_interaction (portal_id, ts, kind, entity_id, label, action, ok)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.portalId, e.ts, e.kind, e.entityId, e.label, e.action, e.ok ? 1 : 0)
  }

  latest(portalId: string): Omit<GuestInteraction, 'portalId'> | null {
    const row = this.db
      .prepare(
        'SELECT ts, kind, entity_id, label, action, ok FROM guest_interaction WHERE portal_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(portalId)

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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/interactions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/store/interactions.ts test/unit/interactions.test.ts
git commit -m "feat: scope InteractionStore to a portal and drop the singleton row"
```

### Task 5: `SettingsStore` — rename `portal_id`, drop per-portal fields, add last-selected

**Files:**
- Modify: `src/server/store/settings.ts` (full current contents 121 lines)
- Test: `test/unit/settings.test.ts` (existing — update it)

**Interfaces:**
- Produces: `getDeploymentId(): string` (renamed from `getPortalId`), `getIntegrationToken(): string` (unchanged), `getLastSelectedPortalId(): string | null` (new), `setLastSelectedPortalId(id: string): void` (new). **Removed:** `getPortalEnabled`, `setPortalEnabled`, `getTheme`, `setTheme`, `getTitle`, `setTitle`, `blocksGuest`, `onPortalEnabledChange`, `PortalEnabledListener` — these move onto `Portal`/`PortalStore` (Task 1) and a new per-portal enablement-change notification (Task 14).

- [ ] **Step 1: Write the failing test**

Read `test/unit/settings.test.ts` first, then replace any test exercising the removed methods with:

```ts
it('renames the deployment id getter without changing its persistence behaviour', () => {
  const store = new SettingsStore(db)
  const first = store.getDeploymentId()
  const second = store.getDeploymentId()
  expect(first).toBe(second)
  expect(typeof first).toBe('string')
})

it('tracks the last-selected portal id', () => {
  const store = new SettingsStore(db)
  expect(store.getLastSelectedPortalId()).toBeNull()
  store.setLastSelectedPortalId('portal-a')
  expect(store.getLastSelectedPortalId()).toBe('portal-a')
})
```

Remove any existing tests for `getPortalEnabled`/`setPortalEnabled`/`getTheme`/`setTheme`/`getTitle`/`setTitle`/`blocksGuest`/`onPortalEnabledChange` — those behaviors moved to `PortalStore` and are covered by Task 1's `test/unit/portals.test.ts` instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/settings.test.ts`
Expected: FAIL — `getDeploymentId`/`getLastSelectedPortalId`/`setLastSelectedPortalId` don't exist yet

- [ ] **Step 3: Rewrite `settings.ts`**

```ts
// src/server/store/settings.ts
import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

const KEY_INTEGRATION_TOKEN = 'integration_token'
const KEY_DEPLOYMENT_ID = 'deployment_id'
const KEY_LAST_SELECTED_PORTAL_ID = 'last_selected_portal_id'

const SettingRowSchema = z.object({
  value: z.string(),
})

export class SettingsStore {
  private db: DatabaseSync

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
   * Used for the integration token and deployment id, which must be stable
   * for the life of the database but are never configured by hand.
   */
  private readOrCreate(key: string, generate: () => string): string {
    const existing = this.read(key)
    if (existing !== null) return existing

    const created = generate()
    this.write(key, created)
    return created
  }

  getIntegrationToken(): string {
    return this.readOrCreate(KEY_INTEGRATION_TOKEN, () => randomBytes(32).toString('hex'))
  }

  /**
   * Identifies this *deployment* for Supervisor discovery and the HA device
   * registry — distinct from any individual portal's own id (`Portal.id`).
   */
  getDeploymentId(): string {
    return this.readOrCreate(KEY_DEPLOYMENT_ID, () => randomUUID())
  }

  getLastSelectedPortalId(): string | null {
    return this.read(KEY_LAST_SELECTED_PORTAL_ID)
  }

  setLastSelectedPortalId(id: string): void {
    this.write(KEY_LAST_SELECTED_PORTAL_ID, id)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/settings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/store/settings.ts test/unit/settings.test.ts
git commit -m "refactor: rename SettingsStore's portal id, move per-portal fields to PortalStore"
```

Note: like Task 2, this leaves call sites in `routes-admin.ts`, `routes-guest.ts`, `routes-integration.ts`, and `runtime.ts` red under `pnpm typecheck` until Tasks 9–14 land — expected mid-plan.

## Phase 2: Auth, session, and shared schemas

### Task 6: `config.ts` — drop `GUEST_PASSWORD`, make `ADMIN_PASSWORD` optional

**Files:**
- Modify: `src/server/config.ts` (full current contents 66 lines)
- Test: `test/unit/config.test.ts` (existing — update it)

**Interfaces:**
- Produces: `Config.adminPassword: string | undefined` (was required `string`). `Config.guestPassword` removed entirely.

- [ ] **Step 1: Write the failing test**

Read `test/unit/config.test.ts` first. Remove/replace any test asserting `GUEST_PASSWORD` is required, or that mismatched `GUEST_PASSWORD`/`ADMIN_PASSWORD` is rejected, with:

```ts
it('loads with no ADMIN_PASSWORD set', () => {
  const cfg = loadConfig({
    HA_BASE_URL: 'http://192.168.1.10:8123',
    HA_TOKEN: 'token',
  } as NodeJS.ProcessEnv)
  expect(cfg.adminPassword).toBeUndefined()
})

it('loads with ADMIN_PASSWORD set', () => {
  const cfg = loadConfig({
    HA_BASE_URL: 'http://192.168.1.10:8123',
    HA_TOKEN: 'token',
    ADMIN_PASSWORD: 'at-least-8-chars',
  } as NodeJS.ProcessEnv)
  expect(cfg.adminPassword).toBe('at-least-8-chars')
})

it('still rejects a too-short ADMIN_PASSWORD when one is supplied', () => {
  expect(() =>
    loadConfig({
      HA_BASE_URL: 'http://192.168.1.10:8123',
      HA_TOKEN: 'token',
      ADMIN_PASSWORD: 'short',
    } as NodeJS.ProcessEnv),
  ).toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/config.test.ts`
Expected: FAIL — current schema requires `GUEST_PASSWORD`, so the first test's env (missing it) throws instead of returning

- [ ] **Step 3: Rewrite `config.ts`**

```ts
// src/server/config.ts
import { z } from 'zod'

const schema = z
  .object({
    HA_BASE_URL: z.url().transform((s) => s.replace(/\/+$/, '')),
    HA_WS_URL: z.url().optional(),
    HA_TOKEN: z.string().min(1),
    ADMIN_PASSWORD: z.string().min(8).optional(),
    PORT: z.coerce.number().int().positive().default(9123),
    INGRESS_PORT: z.coerce.number().int().positive().optional(),
    DB_PATH: z.string().default('/data/portal.db'),
    TRUST_PROXY: z.string().optional(),
  })
  .refine(
    (v) => {
      const url = new URL(v.HA_BASE_URL)
      return !url.hostname.endsWith('.local')
    },
    {
      message:
        'mDNS hostnames (.local) do not resolve inside containers. Use a LAN IP address instead.',
    },
  )

export type Config = {
  haBaseUrl: string
  haWsUrl: string | undefined
  haToken: string
  adminPassword: string | undefined
  port: number
  ingressPort: number | undefined
  dbPath: string
  trustProxy: string | undefined
  /**
   * Directory the built SPA is served from. Defaults to the build output.
   *
   * This exists so tests can point the static root at a scratch directory.
   * They need a known index.html to assert against, and when the root was
   * hardcoded the only way to get one was to write into dist/web — which
   * clobbered the real build for everything downstream, Playwright included.
   */
  webRoot?: string
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const r = schema.safeParse(env)
  if (!r.success) throw new Error(`Invalid configuration:\n${z.prettifyError(r.error)}`)
  const v = r.data
  return {
    haBaseUrl: v.HA_BASE_URL,
    haWsUrl: v.HA_WS_URL,
    haToken: v.HA_TOKEN,
    adminPassword: v.ADMIN_PASSWORD,
    port: v.PORT,
    ingressPort: v.INGRESS_PORT,
    dbPath: v.DB_PATH,
    trustProxy: v.TRUST_PROXY,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/config.ts test/unit/config.test.ts
git commit -m "feat: drop GUEST_PASSWORD from config, make ADMIN_PASSWORD optional"
```

Also update `config.yaml`'s `options`/`schema` sections to drop `guest_password` (the add-on no longer takes it as an option) and mark `admin_password` optional — **do this as part of this task's commit**, since it's the same conceptual change and config.yaml is small:

```yaml
options:
  admin_password: ""
schema:
  admin_password: "password?"
```

(The `?` suffix on the schema value is Home Assistant Supervisor's own syntax for "this option may be omitted.") Read the current full `config.yaml` before editing — only the `options`/`schema` block changes; leave `name`, `version`, `slug`, `ingress`, `ingress_port`, `ports` untouched (per the standing rule against unrequested version/name changes).

### Task 7: `auth.ts` — portal-aware login resolution and session shape

**Files:**
- Modify: `src/server/http/auth.ts` (full current contents 240 lines — only `SessionData`, `SessionStore`, and `classify` change; `LoginRateLimiter` and `clientIp` are untouched, reproduced below verbatim for completeness of the file)
- Test: `test/unit/auth.test.ts` (existing — update it)

**Interfaces:**
- Consumes: `PortalStore.findByPassword` (Task 1), `PortalStore.list`/`get` for the admin-password-collision check at write time (used by Task 9, not here).
- Produces: `SessionData = { role: 'admin'; expiresAt: number } | { role: 'guest'; portalId: string; expiresAt: number }`. `SessionStore.create(session: { role: 'admin' } | { role: 'guest'; portalId: string }): string`. `SessionStore.get(id): SessionData | undefined` (was `Role | undefined` — callers now get the whole session, not just the role, so they can read `portalId`). `classify(supplied: string, cfg: Config, portals: PortalStore): { role: 'admin' } | { role: 'guest'; portalId: string } | null`.

- [ ] **Step 1: Write the failing test**

Read `test/unit/auth.test.ts` first to match existing style (it likely constructs a `Config` fixture directly), then replace the `classify` tests with:

```ts
describe('classify', () => {
  const cfg = { adminPassword: 'admin-secret' } as Config

  it('resolves the admin password to an admin role', () => {
    const portals = new PortalStore(openDb(':memory:'))
    expect(classify('admin-secret', cfg, portals)).toEqual({ role: 'admin' })
  })

  it('resolves a portal password to a guest role scoped to that portal', () => {
    const db = openDb(':memory:')
    const portals = new PortalStore(db)
    const portal = portals.create({ title: 'Timothy', password: 'timothy-pass' })

    expect(classify('timothy-pass', cfg, portals)).toEqual({ role: 'guest', portalId: portal.id })
  })

  it('rejects a password matching nothing', () => {
    const portals = new PortalStore(openDb(':memory:'))
    expect(classify('nope', cfg, portals)).toBeNull()
  })

  it('rejects everything when ADMIN_PASSWORD is unset and no portal matches', () => {
    const noAdminCfg = { adminPassword: undefined } as Config
    const portals = new PortalStore(openDb(':memory:'))
    expect(classify('anything', noAdminCfg, portals)).toBeNull()
  })
})

describe('SessionStore (portal-scoped)', () => {
  it('creates and retrieves a guest session carrying its portal id', () => {
    const sessions = new SessionStore()
    const id = sessions.create({ role: 'guest', portalId: 'portal-123' })
    expect(sessions.get(id)).toEqual({ role: 'guest', portalId: 'portal-123' })
  })

  it('creates and retrieves an admin session with no portal id', () => {
    const sessions = new SessionStore()
    const id = sessions.create({ role: 'admin' })
    expect(sessions.get(id)).toEqual({ role: 'admin' })
  })
})
```

(Import `PortalStore` from `../../src/server/store/portals.js` and `openDb` from `../../src/server/store/db.js` at the top of the test file alongside the existing imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/auth.test.ts`
Expected: FAIL — `classify` takes 2 args today, not 3; `SessionStore.create` takes a `Role` string, not an object

- [ ] **Step 3: Rewrite the changed parts of `auth.ts`**

Full new contents of `src/server/http/auth.ts` (only the top portion through `classify` changes — `LoginRateLimiter` and `clientIp`, lines 610–747 of the original, are copied through completely unchanged):

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Config } from '../config.js'
import type { PortalStore } from '../store/portals.js'

export const SESSION_COOKIE = 'hagp_session'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000

export type SessionData =
  | { role: 'admin'; expiresAt: number }
  | { role: 'guest'; portalId: string; expiresAt: number }

export type NewSession = { role: 'admin' } | { role: 'guest'; portalId: string }

export class SessionStore {
  private readonly sessions = new Map<string, SessionData>()
  private readonly ttlMs: number
  private readonly now: () => number
  private lastSweep: number

  constructor(opts?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? THIRTY_DAYS_MS
    this.now = opts?.now ?? (() => Date.now())
    this.lastSweep = this.now()
  }

  get size(): number {
    return this.sessions.size
  }

  create(session: NewSession): string {
    this.sweepIfNeeded()
    const id = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + this.ttlMs
    this.sessions.set(
      id,
      session.role === 'admin'
        ? { role: 'admin', expiresAt }
        : { role: 'guest', portalId: session.portalId, expiresAt },
    )
    return id
  }

  get(id: string): SessionData | undefined {
    this.sweepIfNeeded()
    const session = this.sessions.get(id)
    if (!session) return undefined

    if (this.now() > session.expiresAt) {
      this.sessions.delete(id)
      return undefined
    }

    session.expiresAt = this.now() + this.ttlMs
    return session
  }

  destroy(id: string): void {
    this.sessions.delete(id)
  }

  sweep(): void {
    const now = this.now()
    for (const [id, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(id)
      }
    }
    this.lastSweep = now
  }

  private sweepIfNeeded(): void {
    const now = this.now()
    if (now - this.lastSweep >= this.ttlMs) {
      this.sweep()
    }
  }
}

// Hash both sides to ensure constant length for timingSafeEqual
export function verifyPassword(supplied: string, expected: string): boolean {
  const suppliedHash = createHash('sha256').update(supplied, 'utf8').digest()
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest()

  try {
    return timingSafeEqual(suppliedHash, expectedHash)
  } catch {
    // timingSafeEqual throws if buffers have different lengths,
    // but we've hashed both so they're always 32 bytes
    return false
  }
}

export function classify(
  supplied: string,
  cfg: Config,
  portals: PortalStore,
): NewSession | null {
  // Every portal password is checked unconditionally, and the admin password
  // (if set) too, so a login attempt's timing does not reveal how many
  // portals exist or which one almost matched.
  const isAdmin = cfg.adminPassword !== undefined && verifyPassword(supplied, cfg.adminPassword)

  let matchedPortalId: string | null = null
  for (const portal of portals.list()) {
    if (verifyPassword(supplied, portal.password)) {
      matchedPortalId = portal.id
    }
  }

  if (isAdmin) return { role: 'admin' }
  if (matchedPortalId !== null) return { role: 'guest', portalId: matchedPortalId }
  return null
}
```

`LoginRateLimiter` and `clientIp` (the remainder of the original file, from the `type IpRecord` declaration through the end) are unchanged — copy them through verbatim from the current file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/http/auth.ts test/unit/auth.test.ts
git commit -m "feat: resolve login against portal passwords, carry portalId on guest sessions"
```

Note: `routes-guest.ts`'s call sites (`classify(password, cfg)`, `sessions.create(role)`, `c.var.role` usage) go red under `pnpm typecheck` until Task 10. Expected mid-plan.

### Task 8: `shared/api.ts` — portal schemas, split deployment vs. per-portal settings

**Files:**
- Modify: `src/shared/api.ts` (full current contents 211 lines)
- Test: `test/unit/api-schemas.test.ts` (existing — update it)

**Interfaces:**
- Produces:
  - `SessionResponse = { role: 'admin' } | { role: 'guest'; portalId: string; portalTitle: string; portalTheme: ThemeId; portalEnabled: boolean }` (discriminated union — a guest's session response now carries enough for the client to render without a second round trip; an admin's does not need a specific portal).
  - `PortalSummarySchema = { id, title, theme, enabled }` (no password) — for `GET /api/admin/portals`.
  - `PortalDetailSchema = PortalSummarySchema & { password: string }` — for `GET /api/admin/portals/:id` (the admin needs to see/reveal it).
  - `PortalCreateRequest = { title: string; password: string }`.
  - `PortalPutRequest = { title?: string; theme?: ThemeId; enabled?: boolean; password?: string }` (all optional — partial update).
  - `DeploymentSettingsResponse = { integrationToken: string; deploymentId: string }`.
  - `IntegrationStateResponse` becomes `{ deploymentId: string; haStale: boolean; version: string; portals: Array<{ portalId: string; title: string; enabled: boolean; deviceCount: number; lastInteraction: Interaction | null }> }`.
  - `IntegrationEnabledRequest` becomes portal-scoped: the portal id travels in the URL path (Task 27's new route), so this schema itself is unchanged (`{ enabled: boolean }`).
  - **Removed:** `AdminPortalResponse`, `AdminPortalPutRequest`, `AdminThemePutRequest`, `AdminTitlePutRequest` (superseded by `PortalSummarySchema`/`PortalDetailSchema`/`PortalPutRequest`/`DeploymentSettingsResponse` above).

- [ ] **Step 1: Write the failing test**

Read `test/unit/api-schemas.test.ts` first. Remove the `describe('CatalogResponse', ...)`-adjacent blocks for `AdminPortalResponse`/`AdminPortalPutRequest`/`AdminThemePutRequest`/`AdminTitlePutRequest` if present (grep the file for those names — they may not have dedicated tests today if only exercised via integration tests; if so, skip removal and just add the new ones), and add:

```ts
describe('SessionResponse', () => {
  it('accepts an admin session with no portal fields', () => {
    const result = SessionResponse.safeParse({ role: 'admin' })
    expect(result.success).toBe(true)
  })

  it('accepts a guest session carrying its portal', () => {
    const result = SessionResponse.safeParse({
      role: 'guest',
      portalId: 'p1',
      portalTitle: "Timothy's Portal",
      portalTheme: 'classic',
      portalEnabled: true,
    })
    expect(result.success).toBe(true)
  })

  it('rejects a guest session missing portal fields', () => {
    const result = SessionResponse.safeParse({ role: 'guest' })
    expect(result.success).toBe(false)
  })
})

describe('PortalSummarySchema / PortalDetailSchema', () => {
  it('summary excludes the password', () => {
    const result = PortalSummaryResponse.safeParse({
      id: 'p1',
      title: 'Timothy',
      theme: 'classic',
      enabled: true,
    })
    expect(result.success).toBe(true)
  })

  it('detail requires the password', () => {
    const result = PortalDetailResponse.safeParse({
      id: 'p1',
      title: 'Timothy',
      theme: 'classic',
      enabled: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('PortalCreateRequest', () => {
  it('accepts title and password', () => {
    const result = PortalCreateRequest.safeParse({ title: 'Timothy', password: 'a-secret-1' })
    expect(result.success).toBe(true)
  })
})

describe('PortalPutRequest', () => {
  it('accepts a partial update', () => {
    const result = PortalPutRequest.safeParse({ enabled: false })
    expect(result.success).toBe(true)
  })

  it('accepts an empty object (no-op update)', () => {
    const result = PortalPutRequest.safeParse({})
    expect(result.success).toBe(true)
  })
})

describe('IntegrationStateResponse', () => {
  it('accepts a list of portals', () => {
    const result = IntegrationStateResponse.safeParse({
      deploymentId: 'd1',
      haStale: false,
      version: '2.0.0',
      portals: [
        {
          portalId: 'p1',
          title: 'Timothy',
          enabled: true,
          deviceCount: 3,
          lastInteraction: null,
        },
      ],
    })
    expect(result.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/api-schemas.test.ts`
Expected: FAIL — none of the new exports exist yet

- [ ] **Step 3: Edit `shared/api.ts`**

Replace the `// Authentication schemas` block (`LoginRequest`, `SessionResponse`) with:

```ts
// Authentication schemas
export const LoginRequest = z.object({
  password: z.string(),
})

export const SessionResponse = z.discriminatedUnion('role', [
  z.object({ role: z.literal('admin') }),
  z.object({
    role: z.literal('guest'),
    portalId: z.string(),
    portalTitle: z.string(),
    portalTheme: z.enum(THEME_IDS),
    portalEnabled: z.boolean(),
  }),
])
```

Replace the `// Portal toggle schemas` block (`AdminPortalResponse` through `AdminTitlePutRequest`) with:

```ts
// Portal management schemas
const PortalFieldsSchema = z.object({
  id: z.string(),
  title: z.string(),
  theme: z.enum(THEME_IDS),
  enabled: z.boolean(),
})

export const PortalSummaryResponse = PortalFieldsSchema
export const PortalsListResponse = z.object({ portals: z.array(PortalFieldsSchema) })

export const PortalDetailResponse = PortalFieldsSchema.extend({
  password: z.string(),
})

// The length cap is enforced here rather than left to `normalizePortalTitle`'s
// silent truncation: an owner who pastes something too long should be told, not
// have the tail quietly removed behind their back.
export const PortalCreateRequest = z.object({
  title: z
    .string()
    .max(MAX_PORTAL_TITLE_LENGTH, `Title must be ${MAX_PORTAL_TITLE_LENGTH} characters or fewer`),
  password: z.string().min(8),
})

export const PortalPutRequest = z.object({
  title: z
    .string()
    .max(MAX_PORTAL_TITLE_LENGTH, `Title must be ${MAX_PORTAL_TITLE_LENGTH} characters or fewer`)
    .optional(),
  theme: z.enum(THEME_IDS).optional(),
  enabled: z.boolean().optional(),
  password: z.string().min(8).optional(),
})

export const DeploymentSettingsResponse = z.object({
  integrationToken: z.string(),
  deploymentId: z.string(),
})

export const LastSelectedPortalPutRequest = z.object({
  portalId: z.string(),
})
```

Replace the `IntegrationStateResponse`/`IntegrationEnabledRequest` block at the end with:

```ts
export const IntegrationStateResponse = z.object({
  deploymentId: z.string(),
  haStale: z.boolean(),
  version: z.string(),
  portals: z.array(
    z.object({
      portalId: z.string(),
      title: z.string(),
      enabled: z.boolean(),
      deviceCount: z.number(),
      lastInteraction: InteractionSchema.nullable(),
    }),
  ),
})

export const IntegrationEnabledRequest = z.object({
  enabled: z.boolean(),
})
```

(`InteractionSchema` above the removed `IntegrationStateResponse` block is unchanged — keep it as-is; the new `IntegrationStateResponse` still references it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/api-schemas.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts test/unit/api-schemas.test.ts
git commit -m "feat: split portal schemas from deployment settings, add portal management schemas"
```

Note: this is the widest-blast-radius task in the plan — every server route file and every web component that imports `AdminPortalResponse`/`AdminPortalPutRequest`/`AdminThemePutRequest`/`AdminTitlePutRequest`/the old `SessionResponse` shape goes red under `pnpm typecheck` until their respective tasks (9–11, 16–26) land. This is expected; do not attempt to keep the old exports around "for compatibility" — there is exactly one server and one client in this repo, both updated by this same plan.

## Phase 3: HTTP API

### Task 9: `routes-guest.ts` — portal-scoped login, session, devices, actions

**Files:**
- Modify: `src/server/http/routes-guest.ts` (full current contents 289 lines)
- Test: `test/integration/routes-guest.test.ts` (existing — update it)

**Interfaces:**
- Consumes: `PortalStore` (Task 1), `classify`/`SessionStore.create`/`.get` new shapes (Task 7), `AllowlistStore.list(portalId)`/`asMap(portalId)` (Task 2), `AuditLog.record` with `portalId` (Task 3), `InteractionStore.record` with `portalId` (Task 4).
- Produces: `Deps` type gains `portals: PortalStore` (this is the shared `Deps` type re-exported and used by `routes-admin.ts`, `routes-integration.ts`, and `runtime.ts` — update all four files' `Deps` in lockstep within this task, since TypeScript will not compile with divergent copies). A new helper, exported for reuse by `runtime.ts` (Task 14): `resolvePortalId(c: HonoContext, session: SessionData): string | null` — for a guest session, returns `session.portalId`; for an admin session, returns the `?portalId=` query param (or `null` if absent/invalid).

- [ ] **Step 1: Write the failing test**

Read `test/integration/routes-guest.test.ts` first in full to match its harness/fixture style (it likely spins up a real `createApp`/`createRuntime` against an in-memory db and a fake HA server). Add/replace tests covering:

```ts
it('logs a guest in and scopes their session to the matching portal', async () => {
  const portal = portals.create({ title: 'Timothy', password: 'timothy-pass' })

  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'timothy-pass' }),
  })

  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toEqual({
    role: 'guest',
    portalId: portal.id,
    portalTitle: 'Timothy',
    portalTheme: 'classic',
    portalEnabled: true,
  })
})

it('only returns devices belonging to the guest\'s own portal', async () => {
  const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
  const mary = portals.create({ title: 'Mary', password: 'mary-pass' })
  allowlist.replace(timothy.id, [
    { entityId: 'light.timothy_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
  ])
  allowlist.replace(mary.id, [
    { entityId: 'light.mary_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
  ])

  const cookie = await loginAs('timothy-pass') // existing test helper — adapt if named differently

  const res = await fetch(`${baseUrl}/api/devices`, { headers: { cookie } })
  const body = await res.json()
  expect(body.devices).toHaveLength(1)
  expect(body.devices[0].entityId).toBe('light.timothy_room')
})

it('lets an admin fetch devices for any portal via ?portalId=', async () => {
  const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
  allowlist.replace(timothy.id, [
    { entityId: 'light.timothy_room', label: 'Room', allowedActions: ['turn_on'], sortOrder: 0 },
  ])

  const adminCookie = await loginAsAdmin() // existing helper — admin has no ADMIN_PASSWORD set in
                                            // most fixtures; use ingress or set ADMIN_PASSWORD in
                                            // this test's server config, matching how the existing
                                            // admin-role tests in this file authenticate today

  const res = await fetch(`${baseUrl}/api/devices?portalId=${timothy.id}`, {
    headers: { cookie: adminCookie },
  })
  const body = await res.json()
  expect(body.devices).toHaveLength(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/integration/routes-guest.test.ts`
Expected: FAIL — current `login` returns the old `SessionResponse` shape, `devices` ignores portal scoping entirely

- [ ] **Step 3: Rewrite `routes-guest.ts`**

```ts
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'
import { validateAction } from '../../shared/devices.js'
import { DevicesResponse, LoginRequest, SessionResponse } from '../../shared/api.js'
import type { HaClient } from '../ha/client.js'
import type { AllowlistStore } from '../store/allowlist.js'
import type { AuditLog } from '../store/auditlog.js'
import type { SettingsStore } from '../store/settings.js'
import type { InteractionStore } from '../store/interactions.js'
import type { PortalStore } from '../store/portals.js'
import type { Config } from '../config.js'
import {
  SESSION_COOKIE,
  type SessionStore,
  type SessionData,
  type LoginRateLimiter,
  classify,
  clientIp,
} from './auth.js'
import type { SseHub } from './sse.js'
import type { Env } from '../app.js'
import type { Context } from 'hono'
import { assembleDevices } from '../device-assembly.js'

export type Deps = {
  cfg: Config
  ha: HaClient
  allowlist: AllowlistStore
  audit: AuditLog
  settings: SettingsStore
  interactions: InteractionStore
  portals: PortalStore
  sessions: SessionStore
  limiter: LoginRateLimiter
  hub: SseHub
}

type HonoContext = Context<Env>

function getClientIp(c: HonoContext, cfg: Config): string {
  const rawIp = c.env.incoming.socket.remoteAddress ?? '0.0.0.0'
  const forwardedFor = c.req.header('x-forwarded-for')
  const trustProxy = cfg.trustProxy
  return clientIp(rawIp, forwardedFor, trustProxy)
}

/**
 * A guest's portal is fixed by their session. An admin session carries no
 * portal of its own — they act on whichever portal `?portalId=` names, since
 * one admin identity reaches every portal.
 */
export function resolvePortalId(c: HonoContext, session: SessionData): string | null {
  if (session.role === 'guest') return session.portalId
  const fromQuery = c.req.query('portalId')
  return fromQuery ?? null
}

const FAILURE_STATUS = {
  not_allowlisted: 404,
  unsupported_domain: 403,
  action_not_valid_for_domain: 403,
  action_not_permitted: 403,
} as const satisfies Record<string, ContentfulStatusCode>

export function createRoutes(deps: Deps) {
  const { cfg, ha, allowlist, audit, settings, interactions, portals, sessions, limiter } = deps

  function sessionResponseFor(session: SessionData): z.infer<typeof SessionResponse> {
    if (session.role === 'admin') return { role: 'admin' }

    const portal = portals.get(session.portalId)
    // The portal was deleted out from under an active guest session. Report
    // disabled rather than throwing: the client's existing "disabled" screen
    // is the correct outcome, and a delete-while-logged-in race is the only
    // way to reach this.
    if (portal === null) {
      return { role: 'guest', portalId: session.portalId, portalTitle: '', portalTheme: 'classic', portalEnabled: false }
    }

    return {
      role: 'guest',
      portalId: portal.id,
      portalTitle: portal.title,
      portalTheme: portal.theme,
      portalEnabled: portal.enabled,
    }
  }

  return {
    // POST /api/login
    async login(c: HonoContext) {
      const ip = getClientIp(c, cfg)

      const rateLimitResult = limiter.check(ip)
      if (!rateLimitResult.allowed) {
        return c.json(
          { error: 'Too many failed login attempts' },
          { status: 429, headers: { 'Retry-After': String(rateLimitResult.retryAfterSec) } },
        )
      }

      const parseResult = LoginRequest.safeParse(await c.req.json())
      if (!parseResult.success) {
        return c.json({ error: 'Invalid request' }, 400)
      }

      const { password } = parseResult.data
      const resolved = classify(password, cfg, portals)

      if (resolved === null) {
        limiter.recordFailure(ip)
        return c.json({ error: 'Invalid credentials' }, 401)
      }

      if (resolved.role === 'guest') {
        const portal = portals.get(resolved.portalId)
        // Cannot be null here in practice — classify() just found this portal
        // by password — but the type is nullable, so this is a defensive exit.
        if (portal === null) {
          limiter.recordFailure(ip)
          return c.json({ error: 'Invalid credentials' }, 401)
        }

        if (!portal.enabled) {
          // Deliberately does NOT call limiter.recordFailure() — the password
          // was correct, and counting it would let a disabled portal lock out
          // a guest who keeps retrying, leaving them locked out after
          // re-enabling.
          return c.json({ error: 'portal_disabled' }, 403)
        }

        limiter.recordSuccess(ip)
        interactions.record({
          portalId: portal.id,
          ts: Date.now(),
          kind: 'login',
          entityId: null,
          label: null,
          action: null,
          ok: true,
        })
      } else {
        limiter.recordSuccess(ip)
      }

      const sessionId = sessions.create(resolved)
      const session = sessions.get(sessionId)
      // Just created it; always present.
      if (session === undefined) throw new Error('Session vanished immediately after creation')

      // httpOnly: prevent XSS
      // SameSite=Lax: prevent CSRF
      // Path=/: session is valid for all routes
      // NO Secure: this is plain HTTP on LAN; setting Secure would cause
      //            browsers to silently drop the cookie, breaking login
      const cookieValue = `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`

      return c.json(SessionResponse.parse(sessionResponseFor(session)), {
        headers: { 'Set-Cookie': cookieValue },
      })
    },

    // POST /api/logout
    async logout(c: HonoContext) {
      const cookie = c.req.header('cookie')
      if (!cookie) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie)
      if (match) {
        const sessionId = match[1]
        if (sessionId) {
          sessions.destroy(sessionId)
        }
      }

      const cookieValue = `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`

      return c.json({ ok: true }, { headers: { 'Set-Cookie': cookieValue } })
    },

    // GET /api/session
    async session(c: HonoContext) {
      const session = c.var.session
      if (!session) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      return c.json(SessionResponse.parse(sessionResponseFor(session)))
    },

    // GET /api/devices
    async devices(c: HonoContext) {
      const session = c.var.session
      if (!session) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      const portalId = resolvePortalId(c, session)
      if (portalId === null) {
        return c.json({ error: 'Missing portalId' }, 400)
      }

      if (session.role === 'guest') {
        const portal = portals.get(portalId)
        if (portal === null || !portal.enabled) {
          return c.json({ error: 'portal_disabled' }, 403)
        }
      }

      const allowlistRows = allowlist.list(portalId)
      const states = ha.getStates()
      const stale = ha.stale

      const devices = assembleDevices(allowlistRows, states, stale)

      return c.json(DevicesResponse.parse({ devices, stale }))
    },

    // POST /api/devices/:entityId/:action
    async callAction(c: HonoContext) {
      const session = c.var.session
      if (!session) {
        return c.json({ error: 'Unauthorized' }, 401)
      }

      const portalId = resolvePortalId(c, session)
      if (portalId === null) {
        return c.json({ error: 'Missing portalId' }, 400)
      }

      if (session.role === 'guest') {
        const portal = portals.get(portalId)
        if (portal === null || !portal.enabled) {
          return c.json({ error: 'portal_disabled' }, 403)
        }
      }

      const entityId = c.req.param('entityId')
      const action = c.req.param('action')

      if (!entityId || !action) {
        return c.json({ error: 'Missing parameters' }, 400)
      }

      const validation = validateAction(entityId, action, allowlist.asMap(portalId))

      const ts = Date.now()

      if (!validation.ok) {
        audit.record({ portalId, ts, entityId, action, role: session.role, ok: false })

        if (session.role === 'guest') {
          interactions.record({
            portalId,
            ts,
            kind: 'action',
            entityId,
            label: allowlist.list(portalId).find((d) => d.entityId === entityId)?.label ?? null,
            action,
            ok: false,
          })
        }

        // not_allowlisted returns 404 to avoid confirming entity existence
        // All other validation failures return 403
        const status = FAILURE_STATUS[validation.reason]
        return c.json(
          { error: validation.reason === 'not_allowlisted' ? 'Not found' : 'Forbidden' },
          status,
        )
      }

      const result = await ha.callAction(validation.domain, validation.service, entityId)

      audit.record({ portalId, ts, entityId, action, role: session.role, ok: result.ok })

      if (session.role === 'guest') {
        interactions.record({
          portalId,
          ts,
          kind: 'action',
          entityId,
          label: allowlist.list(portalId).find((d) => d.entityId === entityId)?.label ?? null,
          action,
          ok: result.ok,
        })
      }

      if (!result.ok) {
        console.error(`HA action failed for ${entityId}/${action}:`, result.message)
        return c.json({ error: 'Service unavailable' }, 503)
      }

      return c.json({ ok: true })
    },

    // GET /api/health
    // Unauthenticated healthcheck for Docker HEALTHCHECK.
    // Reports process health, not Home Assistant reachability — if HA is
    // unreachable we return 200 with haStale:true rather than failing, because
    // restarting the container does not fix HA connectivity and would drop all
    // guest sessions. The portal can still serve pages and actuate devices over
    // REST even when the WebSocket is down.
    async health(c: HonoContext) {
      return c.json({ ok: true, haStale: ha.stale })
    },
  }
}
```

Two notable shape changes from the original, both required by portal-scoping:
- `c.var.role` (a bare `Role`) becomes `c.var.session` (the full `SessionData`), since guest handlers now need `session.portalId` and admin handlers need to know there's no portal on the session at all. `app.ts` (Task 15) sets `c.set('session', ...)` instead of `c.set('role', ...)`.
- The old blanket `settings.blocksGuest(role)` check is gone (that method no longer exists per Task 5) — each handler now checks the *specific resolved portal's* `enabled` flag directly.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/integration/routes-guest.test.ts`
Expected: PASS (adjust the exact fixture helper names — `loginAs`/`loginAsAdmin` — to whatever the existing test file actually calls them; read it before writing Step 1 to use its real names, not the placeholders above)

- [ ] **Step 5: Commit**

```bash
git add src/server/http/routes-guest.ts test/integration/routes-guest.test.ts
git commit -m "feat: scope guest login, session, devices, and actions to a portal"
```

### Task 10: `routes-portals.ts` — portal CRUD, deployment settings, last-selected portal

**Files:**
- Create: `src/server/http/routes-portals.ts`
- Test: `test/integration/routes-portals.test.ts` (new)

**Interfaces:**
- Consumes: `Deps` (Task 9, now including `portals: PortalStore`), `PortalStore.create`/`update`/`delete`/`list`/`get`, `DuplicatePasswordError` (Task 1), `verifyPassword` (Task 7, for the admin-password-collision check).
- Produces: `mountPortalRoutes(app: Hono<Env>, deps: Deps): void`, called from `app.ts` (Task 15) alongside `mountAdminRoutes`.

- [ ] **Step 1: Write the failing test**

```ts
// test/integration/routes-portals.test.ts
// Follow the same harness pattern as test/integration/routes-admin.test.ts —
// read that file first for how it stands up createApp/createRuntime with an
// in-memory db and a fake HA server, and how it authenticates as admin.

describe('portal management routes', () => {
  it('creates, lists, updates, and deletes a portal', async () => {
    const adminCookie = await loginAsAdmin()

    const created = await fetch(`${baseUrl}/api/admin/portals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'Timothy', password: 'a-secret-1' }),
    }).then((r) => r.json())
    expect(created.title).toBe('Timothy')

    const list = await fetch(`${baseUrl}/api/admin/portals`, {
      headers: { cookie: adminCookie },
    }).then((r) => r.json())
    expect(list.portals).toHaveLength(1)

    const updated = await fetch(`${baseUrl}/api/admin/portals/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'Tim' }),
    }).then((r) => r.json())
    expect(updated.title).toBe('Tim')

    const del = await fetch(`${baseUrl}/api/admin/portals/${created.id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    })
    expect(del.status).toBe(200)

    const listAfter = await fetch(`${baseUrl}/api/admin/portals`, {
      headers: { cookie: adminCookie },
    }).then((r) => r.json())
    expect(listAfter.portals).toHaveLength(0)
  })

  it('rejects creating a portal whose password matches an existing one', async () => {
    const adminCookie = await loginAsAdmin()

    await fetch(`${baseUrl}/api/admin/portals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'Timothy', password: 'shared-pass' }),
    })

    const res = await fetch(`${baseUrl}/api/admin/portals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'Mary', password: 'shared-pass' }),
    })

    expect(res.status).toBe(409)
  })

  it('rejects a portal password matching ADMIN_PASSWORD', async () => {
    // This test's server fixture must set ADMIN_PASSWORD — check how
    // test/integration/routes-admin.test.ts's admin-role tests configure cfg
    // and reuse that pattern, e.g. cfg.adminPassword = 'admin-secret'.
    const adminCookie = await loginAsAdmin()

    const res = await fetch(`${baseUrl}/api/admin/portals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'Timothy', password: 'admin-secret' }),
    })

    expect(res.status).toBe(409)
  })

  it('returns deployment settings', async () => {
    const adminCookie = await loginAsAdmin()

    const res = await fetch(`${baseUrl}/api/admin/settings`, {
      headers: { cookie: adminCookie },
    }).then((r) => r.json())

    expect(typeof res.integrationToken).toBe('string')
    expect(typeof res.deploymentId).toBe('string')
  })

  it('persists the last-selected portal', async () => {
    const adminCookie = await loginAsAdmin()
    const created = await fetch(`${baseUrl}/api/admin/portals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ title: 'Timothy', password: 'a-secret-2' }),
    }).then((r) => r.json())

    const res = await fetch(`${baseUrl}/api/admin/last-selected-portal`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ portalId: created.id }),
    })
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/integration/routes-portals.test.ts`
Expected: FAIL — `/api/admin/portals` doesn't exist (404)

- [ ] **Step 3: Write `routes-portals.ts`**

```ts
// src/server/http/routes-portals.ts
import type { Hono } from 'hono'
import type { Env } from '../app.js'
import type { Deps } from './routes-guest.js'
import { verifyPassword } from './auth.js'
import { DuplicatePasswordError } from '../store/portals.js'
import {
  DeploymentSettingsResponse,
  LastSelectedPortalPutRequest,
  PortalCreateRequest,
  PortalDetailResponse,
  PortalPutRequest,
  PortalsListResponse,
  AllowlistPutRequest,
  AllowlistResponse,
} from '../../shared/api.js'

export function mountPortalRoutes(app: Hono<Env>, deps: Deps): void {
  const { portals, cfg, allowlist, ha, settings } = deps

  function collidesWithAdminPassword(password: string): boolean {
    return cfg.adminPassword !== undefined && verifyPassword(password, cfg.adminPassword)
  }

  app.get('/api/admin/portals', (c) => {
    return c.json(PortalsListResponse.parse({ portals: portals.list() }))
  })

  app.post('/api/admin/portals', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = PortalCreateRequest.safeParse(body)
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0]
      return c.json({ error: firstIssue ? firstIssue.message : 'Invalid request' }, 400)
    }

    if (collidesWithAdminPassword(parseResult.data.password)) {
      return c.json({ error: 'That password is already in use' }, 409)
    }

    try {
      const created = portals.create(parseResult.data)
      return c.json(PortalDetailResponse.parse(created))
    } catch (error) {
      if (error instanceof DuplicatePasswordError) {
        return c.json({ error: error.message }, 409)
      }
      throw error
    }
  })

  app.get('/api/admin/portals/:portalId', (c) => {
    const portal = portals.get(c.req.param('portalId'))
    if (portal === null) return c.json({ error: 'Not found' }, 404)
    return c.json(PortalDetailResponse.parse(portal))
  })

  app.put('/api/admin/portals/:portalId', async (c) => {
    const portalId = c.req.param('portalId')
    if (portals.get(portalId) === null) return c.json({ error: 'Not found' }, 404)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = PortalPutRequest.safeParse(body)
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0]
      return c.json({ error: firstIssue ? firstIssue.message : 'Invalid request' }, 400)
    }

    if (parseResult.data.password !== undefined && collidesWithAdminPassword(parseResult.data.password)) {
      return c.json({ error: 'That password is already in use' }, 409)
    }

    try {
      const updated = portals.update(portalId, parseResult.data)
      return c.json(PortalDetailResponse.parse(updated))
    } catch (error) {
      if (error instanceof DuplicatePasswordError) {
        return c.json({ error: error.message }, 409)
      }
      throw error
    }
  })

  app.delete('/api/admin/portals/:portalId', (c) => {
    portals.delete(c.req.param('portalId'))
    return c.json({ ok: true })
  })

  // GET/PUT allowlist for one portal — same payload shape as the old global
  // /api/admin/allowlist, now scoped by path param.
  app.get('/api/admin/portals/:portalId/allowlist', async (c) => {
    const portalId = c.req.param('portalId')
    const devices = allowlist.list(portalId)
    const catalog = await ha.getCatalog()

    const catalogEntityIds = new Set(catalog.map((entry) => entry.entityId))
    const orphaned = devices
      .filter((device) => !catalogEntityIds.has(device.entityId))
      .map((device) => device.entityId)

    return c.json(AllowlistResponse.parse({ devices, orphaned }))
  })

  app.put('/api/admin/portals/:portalId/allowlist', async (c) => {
    const portalId = c.req.param('portalId')

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = AllowlistPutRequest.safeParse(body)
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0]
      return c.json({ error: firstIssue ? firstIssue.message : 'Invalid request' }, 400)
    }

    allowlist.replace(portalId, parseResult.data.devices)
    return c.json({ ok: true })
  })

  app.get('/api/admin/settings', (c) => {
    return c.json(
      DeploymentSettingsResponse.parse({
        integrationToken: settings.getIntegrationToken(),
        deploymentId: settings.getDeploymentId(),
      }),
    )
  })

  app.put('/api/admin/last-selected-portal', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const parseResult = LastSelectedPortalPutRequest.safeParse(body)
    if (!parseResult.success) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    settings.setLastSelectedPortalId(parseResult.data.portalId)
    return c.json({ ok: true })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/integration/routes-portals.test.ts`
Expected: PASS (once Task 15 wires `mountPortalRoutes` into `app.ts` — if writing/running this task strictly before Task 15, the test harness must call `mountPortalRoutes` directly rather than going through the full `createApp`; check how `test/integration/routes-admin.test.ts` bootstraps its app under test and either wire this task's mount call there too now, or accept this test stays red until Task 15 and note that explicitly when running it)

- [ ] **Step 5: Commit**

```bash
git add src/server/http/routes-portals.ts test/integration/routes-portals.test.ts
git commit -m "feat: add portal CRUD, deployment settings, and last-selected-portal routes"
```

### Task 11: `routes-admin.ts` — trim to just the entity catalog

**Files:**
- Modify: `src/server/http/routes-admin.ts` (full current contents 156 lines)
- Test: `test/integration/routes-admin.test.ts` (existing — remove the tests for routes that moved)

**Interfaces:**
- Produces: `mountAdminRoutes` now only mounts the admin-role-check middleware and `GET /api/admin/entities`. Everything else (`/api/admin/allowlist`, `/api/admin/portal`, `/api/admin/theme`, `/api/admin/title`) is removed — superseded by Task 10's `routes-portals.ts`.

- [ ] **Step 1: Update the test file**

Read `test/integration/routes-admin.test.ts` in full. Remove every test exercising `/api/admin/allowlist`, `/api/admin/portal`, `/api/admin/theme`, `/api/admin/title` (their coverage now lives in `test/integration/routes-portals.test.ts`, Task 10). Keep only the `/api/admin/entities` tests and the admin-role-required middleware test (a non-admin session getting 403, an unauthenticated request getting 401) — those still apply to whatever routes remain in this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/integration/routes-admin.test.ts`
Expected: the remaining tests still pass against the *old* file (nothing to fail yet) — this task's red/green cycle is really about Step 3 not breaking the surviving tests. Confirm current state passes before editing, then re-run after Step 3.

- [ ] **Step 3: Trim `routes-admin.ts`**

`Env['Variables']` still only has `role: Role` at this point in the plan's sequencing — it doesn't gain a real `session: SessionData` field until Task 15 rewrites `app.ts`. `routes-guest.ts` (Task 9) hit the same problem and worked around it with a local `currentSession` shim that casts `c.get('role')`; give this file the same interim shim rather than writing `c.var.session`, which will not compile until Task 15 lands:

```ts
// src/server/http/routes-admin.ts
import type { Hono } from 'hono'
import type { Env } from '../app.js'
import type { Deps } from './routes-guest.js'
import type { SessionData } from './auth.js'
import { CatalogResponse } from '../../shared/api.js'

export function mountAdminRoutes(app: Hono<Env>, deps: Deps): void {
  const { ha } = deps

  app.use('/api/admin/*', async (c, next) => {
    // Interim cast: Env['Variables'] only has `role: Role` until Task 15 adds
    // a real `session: SessionData` field. Mirrors routes-guest.ts's
    // currentSession shim (Task 9) for the same reason; Task 15 removes both.
    const session = c.get('role') as unknown as SessionData | undefined

    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    if (session.role !== 'admin') {
      return c.json({ error: 'Forbidden' }, 403)
    }

    await next()
  })

  app.get('/api/admin/entities', async (c) => {
    const catalog = await ha.getCatalog()
    return c.json(CatalogResponse.parse({ entities: catalog }))
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/integration/routes-admin.test.ts`
Expected: PASS (the surviving tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/http/routes-admin.ts test/integration/routes-admin.test.ts
git commit -m "refactor: trim routes-admin.ts to the entity catalog now that portals have their own routes"
```

## Phase 4: Realtime updates (SSE)

### Task 12: `SseHub` — bind connections to a portal, route patches per-portal

**Files:**
- Modify: `src/server/http/sse.ts` (full current contents 197 lines)
- Test: `test/unit/sse.test.ts` (existing — update it)

**Interfaces:**
- Produces: `add(res: ServerResponse, role: Role, portalId: string | null): () => void` (portalId is `null` for an admin viewing no particular portal — e.g. mid-dropdown-switch — though in practice `runtime.ts`, Task 14, always resolves one before calling `add`). `broadcastToPortal(portalId: string, frame: SseFrame): void` (new — replaces the old blanket `broadcast` for device/patch/degraded frames). `broadcast(frame: SseFrame): void` stays, for frames that are genuinely global (there are none left after this plan, but the method is kept rather than removed since `close()`/tests may still reference an "everyone" concept — do not delete it, just stop routing device state through it). `closePortalGuests(portalId: string): void` (replaces `closeRole('guest')` — ends only guest connections bound to the given portal, leaving other portals' guests and all admins connected).

- [ ] **Step 1: Write the failing test**

Read `test/unit/sse.test.ts` first to match its existing fake-`ServerResponse` fixture style, then add/replace:

```ts
it('routes a patch only to connections bound to the affected portal', () => {
  const hub = new SseHub()
  const resA = fakeResponse()
  const resB = fakeResponse()
  hub.add(resA, 'guest', 'portal-a')
  hub.add(resB, 'guest', 'portal-b')

  hub.broadcastToPortal('portal-a', { type: 'patch', devices: [] })

  expect(resA.writtenData()).toContain('"type":"patch"')
  expect(resB.writtenData()).toBe('')
})

it('closePortalGuests ends only that portal\'s guest connections', () => {
  const hub = new SseHub()
  const guestA = fakeResponse()
  const guestB = fakeResponse()
  const adminA = fakeResponse()
  hub.add(guestA, 'guest', 'portal-a')
  hub.add(guestB, 'guest', 'portal-b')
  hub.add(adminA, 'admin', 'portal-a')

  hub.closePortalGuests('portal-a')

  expect(guestA.ended).toBe(true)
  expect(guestB.ended).toBe(false)
  expect(adminA.ended).toBe(false)
})
```

(Adapt `fakeResponse()`/`writtenData()`/`.ended` to whatever helper the existing test file already uses for a fake `ServerResponse` — read it first rather than inventing a second fixture shape.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/sse.test.ts`
Expected: FAIL — `add` takes 2 args today, `broadcastToPortal`/`closePortalGuests` don't exist

- [ ] **Step 3: Rewrite `sse.ts`**

```ts
import type { ServerResponse } from 'node:http'
import type { Role, SseFrame } from '../../shared/api.js'

type ClientInfo = { role: Role; portalId: string | null }

export class SseHub {
  private readonly clients = new Map<ServerResponse, ClientInfo>()
  private readonly heartbeatMs: number
  private readonly maxBufferBytes: number
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(opts?: { heartbeatMs?: number; maxBufferBytes?: number }) {
    this.heartbeatMs = opts?.heartbeatMs ?? 25_000
    this.maxBufferBytes = opts?.maxBufferBytes ?? 1_048_576
  }

  add(res: ServerResponse, role: Role, portalId: string | null): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // Flush headers immediately so EventSource fires 'open'
    res.flushHeaders()

    this.clients.set(res, { role, portalId })

    if (this.clients.size === 1 && this.heartbeatTimer === null) {
      this.startHeartbeat()
    }

    const remove = () => {
      if (this.clients.has(res)) {
        this.clients.delete(res)
        if (this.clients.size === 0) {
          this.stopHeartbeat()
        }
      }
    }

    res.on('close', remove)
    res.on('error', remove)

    return () => {
      res.off('close', remove)
      res.off('error', remove)
      remove()
      if (!res.writableEnded) {
        res.end()
      }
    }
  }

  private writeFrame(client: ServerResponse, frame: SseFrame): void {
    let data: string
    try {
      data = `data: ${JSON.stringify(frame)}\n\n`
    } catch {
      // Frame not serialisable - drop this send
      return
    }

    try {
      if (client.writableEnded) return

      if (client.writableLength > this.maxBufferBytes) {
        this.clients.delete(client)
        client.end()
        return
      }

      client.write(data)
    } catch {
      this.clients.delete(client)
    }
  }

  broadcast(frame: SseFrame): void {
    for (const client of this.clients.keys()) {
      this.writeFrame(client, frame)
    }
  }

  broadcastToPortal(portalId: string, frame: SseFrame): void {
    for (const [client, info] of this.clients) {
      if (info.portalId === portalId) {
        this.writeFrame(client, frame)
      }
    }
  }

  /**
   * Ends every guest stream bound to this portal, leaving its admins and every
   * other portal's connections untouched. Used by the kill-switch: disabling
   * one portal must drop only that portal's guests.
   */
  closePortalGuests(portalId: string): void {
    for (const [client, info] of this.clients) {
      if (info.role !== 'guest' || info.portalId !== portalId) continue

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

  send(res: ServerResponse, frame: SseFrame): void {
    this.writeFrame(res, frame)
  }

  get clientCount(): number {
    return this.clients.size
  }

  close(): void {
    for (const client of this.clients.keys()) {
      if (!client.writableEnded) {
        client.end()
      }
    }
    this.clients.clear()
    this.stopHeartbeat()
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const ping = ': ping\n\n'

      for (const client of this.clients.keys()) {
        try {
          if (client.writableEnded) continue

          if (client.writableLength > this.maxBufferBytes) {
            this.clients.delete(client)
            client.end()
            continue
          }

          client.write(ping)
        } catch {
          this.clients.delete(client)
        }
      }

      if (this.clients.size === 0) {
        this.stopHeartbeat()
      }
    }, this.heartbeatMs)

    this.heartbeatTimer.unref()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
```

(`send()` is now a one-line wrapper around the same `writeFrame` helper `broadcast`/`broadcastToPortal` use, rather than duplicating the try/catch — a small dedup that falls out naturally from this rewrite, not a scope-creeping refactor.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/sse.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/http/sse.ts test/unit/sse.test.ts
git commit -m "feat: bind SSE connections to a portal, route patches per-portal"
```

### Task 13: `PortalStore` — notify when a portal's `enabled` flag changes

**Files:**
- Modify: `src/server/store/portals.ts` (Task 1's file — add a listener mechanism, same shape as the `onPortalEnabledChange` this replaces from the old `SettingsStore`)
- Test: `test/unit/portals.test.ts` (Task 1's file — extend it)

**Interfaces:**
- Produces: `PortalStore.onEnabledChange(fn: (portalId: string, enabled: boolean) => void): () => void`. `update()` fires it only when the `enabled` field's value actually changes (not on every update call).

- [ ] **Step 1: Write the failing test**

Append to `test/unit/portals.test.ts`:

```ts
it('notifies onEnabledChange only when enabled actually flips', () => {
  const created = store.create({ title: 'Timothy', password: 'a-secret-4' })
  const seen: Array<{ portalId: string; enabled: boolean }> = []
  store.onEnabledChange((portalId, enabled) => seen.push({ portalId, enabled }))

  store.update(created.id, { title: 'Tim' }) // no enabled change
  expect(seen).toEqual([])

  store.update(created.id, { enabled: false })
  expect(seen).toEqual([{ portalId: created.id, enabled: false }])

  store.update(created.id, { enabled: false }) // already false, no change
  expect(seen).toEqual([{ portalId: created.id, enabled: false }])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/portals.test.ts`
Expected: FAIL — `onEnabledChange` does not exist

- [ ] **Step 3: Add the listener to `portals.ts`**

Add a `private listeners: Set<(portalId: string, enabled: boolean) => void> = new Set()` field to the class, an `onEnabledChange` method identical in shape to `AllowlistStore.onChange` (Task 2), and change `update()` to compare `current.enabled` against `next.enabled` before/after the write and notify on a real change:

```ts
// Add near the top of the class, alongside the constructor:
private enabledListeners: Set<(portalId: string, enabled: boolean) => void> = new Set()

onEnabledChange(fn: (portalId: string, enabled: boolean) => void): () => void {
  this.enabledListeners.add(fn)
  return () => {
    this.enabledListeners.delete(fn)
  }
}

// Change the end of `update()` from:
//   const updated = this.get(id)
//   if (updated === null) throw new Error(`Portal ${id} vanished during update`)
//   return updated
// to:
const updated = this.get(id)
if (updated === null) throw new Error(`Portal ${id} vanished during update`)

if (updated.enabled !== current.enabled) {
  for (const listener of this.enabledListeners) {
    listener(id, updated.enabled)
  }
}

return updated
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/portals.test.ts`
Expected: PASS (all tests in the file, including Task 1's original 6)

- [ ] **Step 5: Commit**

```bash
git add src/server/store/portals.ts test/unit/portals.test.ts
git commit -m "feat: notify when a portal's enabled flag changes"
```

### Task 14: `runtime.ts` — per-portal SSE fan-out

**Files:**
- Modify: `src/server/runtime.ts` (full current contents 337 lines)
- Test: `test/integration/server-process.test.ts`, `test/integration/portal-toggle.test.ts` (existing — update both)

**Interfaces:**
- Consumes: `SseHub.add(res, role, portalId)`/`.broadcastToPortal`/`.closePortalGuests` (Task 12), `AllowlistStore.onChange((portalId, entityIds) => ...)` (Task 2), `PortalStore.onEnabledChange` (Task 13), `resolvePortalId` (Task 9, re-exported from `routes-guest.ts`).
- Produces: `Deps` (this file's own copy, kept structurally identical to `routes-guest.ts`'s `Deps` — add `portals: PortalStore` here too).

- [ ] **Step 1: Write the failing test**

Read both `test/integration/server-process.test.ts` and `test/integration/portal-toggle.test.ts` in full first — they exercise `/api/stream` end-to-end against a real HTTP server. Neither file currently asserts anything about SSE frame *content* (snapshot-on-connect, patch-on-state-change, degraded-on-drop, fresh-snapshot-on-allowlist-change) — that coverage used to live in `test/integration/routes-guest.test.ts`'s `'SSE streaming'` describe block, which Task 9 removed because it exercised runtime.ts machinery this task is what actually rewrites. Its two helpers (`openStream`/`waitForFrame`) were deleted along with it and exist nowhere now. Add both helpers to `test/integration/portal-toggle.test.ts` (near its other top-level helpers, alongside `loginAs`):

```ts
import type { SseFrame } from '../../src/shared/api.ts'

async function openStream(baseUrl: string, cookie: string) {
  const ctrl = new AbortController()
  const res = await fetch(`${baseUrl}/api/stream`, {
    headers: { Cookie: cookie },
    signal: ctrl.signal,
  })
  const reader = res.body?.getReader()
  if (!reader) throw new Error('no body')
  const dec = new TextDecoder()
  const frames: SseFrame[] = []
  const pump = (async () => {
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        for (;;) {
          const i = buf.indexOf('\n\n')
          if (i === -1) break
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const line = chunk.split('\n').find((l) => l.startsWith('data: '))
          if (line) frames.push(JSON.parse(line.slice(6)))
        }
      }
    } catch {
      // aborted
    }
  })()
  return { res, frames, abort: () => ctrl.abort(), pump }
}

async function waitForFrame(frames: SseFrame[], type: string, ms = 5000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (frames.some((f) => f.type === type)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}
```

Then add these tests, which pin the basic per-connection mechanics before the cross-portal routing tests below pin the isolation:

```ts
it('emits a snapshot immediately on connect, scoped to the guest\'s own portal', async () => {
  const portal = portals.create({ title: 'Timothy', password: 'snapshot-connect-pass' })
  allowlist.replace(portal.id, [
    { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on', 'turn_off'], sortOrder: 1 },
  ])
  const { cookie } = await loginAs('snapshot-connect-pass')

  const stream = await openStream(baseUrl, cookie)
  expect(stream.res.status).toBe(200)
  expect(stream.res.headers.get('content-type')).toBe('text/event-stream')

  expect(await waitForFrame(stream.frames, 'snapshot')).toBe(true)
  const snapshot = stream.frames.find((f) => f.type === 'snapshot')
  if (snapshot?.type !== 'snapshot') throw new Error('Expected snapshot frame')
  expect(snapshot.devices.map((d) => d.entityId)).toEqual(['light.porch'])

  stream.abort()
  await stream.pump
})

it('emits a patch after a state change, then degraded after the connection drops', async () => {
  const portal = portals.create({ title: 'Timothy', password: 'patch-degraded-pass' })
  allowlist.replace(portal.id, [
    { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on', 'turn_off'], sortOrder: 1 },
  ])
  const { cookie } = await loginAs('patch-degraded-pass')

  const stream = await openStream(baseUrl, cookie)
  await waitForFrame(stream.frames, 'snapshot')

  fake.setState('light.porch', 'on')
  expect(await waitForFrame(stream.frames, 'patch')).toBe(true)

  fake.drop()
  expect(await waitForFrame(stream.frames, 'degraded')).toBe(true)
  const degraded = stream.frames.find((f) => f.type === 'degraded')
  expect(degraded).toMatchObject({ stale: true })

  stream.abort()
  await stream.pump
})

it('emits a fresh snapshot when that portal\'s allowlist changes', async () => {
  const portal = portals.create({ title: 'Timothy', password: 'allowlist-snapshot-pass' })
  allowlist.replace(portal.id, [
    { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on', 'turn_off'], sortOrder: 1 },
    { entityId: 'switch.fan', label: 'Fan', allowedActions: ['turn_on', 'turn_off'], sortOrder: 2 },
  ])
  const { cookie } = await loginAs('allowlist-snapshot-pass')

  const stream = await openStream(baseUrl, cookie)
  await waitForFrame(stream.frames, 'snapshot')
  const countBefore = stream.frames.filter((f) => f.type === 'snapshot').length

  allowlist.replace(portal.id, [
    { entityId: 'light.porch', label: 'Porch', allowedActions: ['turn_on', 'turn_off'], sortOrder: 1 },
  ])

  const t0 = Date.now()
  while (Date.now() - t0 < 5000) {
    if (stream.frames.filter((f) => f.type === 'snapshot').length > countBefore) break
    await new Promise((r) => setTimeout(r, 25))
  }
  const snapshots = stream.frames.filter((f) => f.type === 'snapshot')
  expect(snapshots.length).toBeGreaterThan(countBefore)
  const latest = snapshots[snapshots.length - 1]
  if (latest?.type !== 'snapshot') throw new Error('Expected snapshot frame')
  expect(latest.devices.map((d) => d.entityId)).toEqual(['light.porch'])

  stream.abort()
  await stream.pump
})

it('only streams patches for the portal a guest is bound to', async () => {
  const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
  const mary = portals.create({ title: 'Mary', password: 'mary-pass' })
  allowlist.replace(timothy.id, [
    { entityId: 'light.shared', label: 'Shared', allowedActions: ['turn_on'], sortOrder: 0 },
  ])
  allowlist.replace(mary.id, [
    { entityId: 'light.shared', label: 'Shared', allowedActions: ['turn_on'], sortOrder: 0 },
  ])

  const timothyCookie = await loginAs('timothy-pass')
  const maryCookie = await loginAs('mary-pass')

  const timothyEvents = collectSseEvents(`${baseUrl}/api/stream`, timothyCookie) // existing helper
  const maryEvents = collectSseEvents(`${baseUrl}/api/stream`, maryCookie)

  fake.setState('light.shared', 'on')

  await waitForPatch(timothyEvents, 'light.shared', 'on')
  await waitForPatch(maryEvents, 'light.shared', 'on')

  // Both received it independently — this assertion is really about the
  // *routing*, proven properly by the next case.
})

it('disabling one portal drops only that portal\'s guest stream', async () => {
  const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-2' })
  const mary = portals.create({ title: 'Mary', password: 'mary-pass-2' })

  const timothyCookie = await loginAs('timothy-pass-2')
  const maryCookie = await loginAs('mary-pass-2')

  const timothyStream = openSseConnection(`${baseUrl}/api/stream`, timothyCookie) // existing helper
  const maryStream = openSseConnection(`${baseUrl}/api/stream`, maryCookie)

  portals.update(timothy.id, { enabled: false })

  await expect(timothyStream.closed()).resolves.toBe(true)
  expect(maryStream.isClosed()).toBe(false)
})
```

(Names like `collectSseEvents`/`waitForPatch`/`openSseConnection` are placeholders for whatever this test file's existing SSE test helpers are actually called — read the file first and use its real helper names; do not invent a second set of SSE test utilities.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/integration/server-process.test.ts test/integration/portal-toggle.test.ts`
Expected: FAIL

- [ ] **Step 3: Rewrite `runtime.ts`**

The file's structure is unchanged (`requestPathname`, `isFromSupervisor`, `checkSession` helpers stay as-is, though `checkSession` now returns `SessionData | null` instead of `Role | null` since it just forwards `sessions.get(sessionId) ?? null` — Task 9 already changed what `SessionStore.get` returns, so this function's return type updates for free). The parts that change are `Deps`, the four wiring callbacks inside `createRuntime`, and both `/api/stream` interceptors:

```ts
export type Deps = {
  cfg: Config
  ha: HaClient
  allowlist: AllowlistStore
  audit: AuditLog
  settings: SettingsStore
  interactions: InteractionStore
  portals: PortalStore
  sessions: SessionStore
  limiter: LoginRateLimiter
  hub: SseHub
}

// Shared session check used by both Hono middleware and SSE handler
export function checkSession(cookie: string | undefined, sessions: SessionStore): SessionData | null {
  if (!cookie) return null

  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(cookie)
  if (!match) return null

  const sessionId = match[1]
  if (!sessionId) return null

  return sessions.get(sessionId) ?? null
}
```

Inside `createRuntime`, replace the four wiring blocks:

```ts
export function createRuntime(deps: Deps): Runtime {
  const { ha, allowlist, hub, sessions, portals } = deps

  // Wire allowlist.onChange → ha.setWatchedEntities (union across ALL portals)
  // → broadcast a fresh snapshot to just the portal that changed.
  allowlist.onChange((portalId, _entityIds) => {
    const allPortalIds = portals.list().map((p) => p.id)
    const watchedAcrossAllPortals = new Set<string>()
    for (const id of allPortalIds) {
      for (const entityId of allowlist.entityIds(id)) {
        watchedAcrossAllPortals.add(entityId)
      }
    }

    ha.setWatchedEntities([...watchedAcrossAllPortals])
      .then(() => {
        const allowlistRows = allowlist.list(portalId)
        const states = ha.getStates()
        const stale = ha.stale
        const devices = assembleDevices(allowlistRows, states, stale)

        const snapshot: SseFrame = SseFrameSchema.parse({ type: 'snapshot', devices, stale })
        hub.broadcastToPortal(portalId, snapshot)
      })
      .catch((error) => {
        console.error('Failed to update watched entities:', error)
      })
  })

  // Wire ha.onChange → for each portal whose allowlist includes a changed
  // entity, broadcast a patch scoped to that portal. One HA state change can
  // fan out to more than one portal, since an entity may be shared.
  ha.onChange((changedStates) => {
    const stale = ha.stale

    for (const portal of portals.list()) {
      const allowlistRows = allowlist.list(portal.id)
      const affectedRows = allowlistRows.filter((row) => changedStates.has(row.entityId))
      if (affectedRows.length === 0) continue

      const changedDevices = assembleDevices(affectedRows, changedStates, stale)
      const patch: SseFrame = SseFrameSchema.parse({ type: 'patch', devices: changedDevices })
      hub.broadcastToPortal(portal.id, patch)
    }
  })

  // Wire ha.onStaleChange → broadcast to everyone (HA reachability is a
  // deployment-wide fact, not a per-portal one — `broadcast`, not
  // `broadcastToPortal`, is correct here).
  ha.onStaleChange((stale) => {
    const degraded: SseFrame = SseFrameSchema.parse({ type: 'degraded', stale })
    hub.broadcast(degraded)
  })

  // Wire portals.onEnabledChange → broadcast to that portal + drop its guests.
  portals.onEnabledChange((portalId, enabled) => {
    const frame: SseFrame = SseFrameSchema.parse({ type: 'portal', enabled })
    hub.broadcastToPortal(portalId, frame)

    // Broadcast first, then drop: a guest that receives the frame switches to
    // the disabled screen immediately. Closing the stream is the fallback —
    // the client's existing stream-drop recheck hits /api/session and lands on
    // the same screen even if the frame was missed.
    if (!enabled) {
      hub.closePortalGuests(portalId)
    }
  })

  const app = createApp(deps)
  const honoListener = getRequestListener(app.fetch)

  function handleDirectRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) {
    try {
      let pathname = requestPathname(req.url)
      if (pathname.endsWith('/') && pathname.length > 1) {
        pathname = pathname.slice(0, -1)
      }

      if (pathname === '/api/stream' && req.method === 'GET') {
        const session = checkSession(req.headers.cookie, sessions)
        if (!session) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }

        const url = new URL(req.url ?? '/', 'http://localhost')
        const portalId =
          session.role === 'guest' ? session.portalId : url.searchParams.get('portalId')

        if (portalId === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing portalId' }))
          return
        }

        if (session.role === 'guest') {
          const portal = portals.get(portalId)
          if (portal === null || !portal.enabled) {
            res.writeHead(403, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'portal_disabled' }))
            return
          }
        }

        hub.add(res, session.role, portalId)

        const allowlistRows = allowlist.list(portalId)
        const states = ha.getStates()
        const stale = ha.stale
        const devices = assembleDevices(allowlistRows, states, stale)

        const snapshot: SseFrame = SseFrameSchema.parse({ type: 'snapshot', devices, stale })
        hub.send(res, snapshot)
        return
      }

      honoListener(req, res)
    } catch (error) {
      console.error('Uncaught error in handleDirectRequest:', error)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal Server Error' }))
      } else {
        res.destroy()
      }
    }
  }

  function handleIngressRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) {
    const remoteAddress = req.socket.remoteAddress

    // Ingress listener security gate: ONLY Supervisor connections allowed
    // This must be the first check - before static serving, before SSE, before Hono
    // Keep this outside try/catch - it must not become reachable through an error path
    if (!isFromSupervisor(remoteAddress)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Forbidden' }))
      return
    }

    try {
      // Valid Supervisor request - continue to handler logic
      let pathname = requestPathname(req.url)
      if (pathname.endsWith('/') && pathname.length > 1) {
        pathname = pathname.slice(0, -1)
      }

      if (pathname === '/api/stream' && req.method === 'GET') {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const portalId = url.searchParams.get('portalId')

        if (portalId === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing portalId' }))
          return
        }

        hub.add(res, 'admin', portalId)

        const allowlistRows = allowlist.list(portalId)
        const states = ha.getStates()
        const stale = ha.stale
        const devices = assembleDevices(allowlistRows, states, stale)

        const snapshot: SseFrame = SseFrameSchema.parse({ type: 'snapshot', devices, stale })
        hub.send(res, snapshot)
        return
      }

      honoListener(req, res)
    } catch (error) {
      console.error('Uncaught error in handleIngressRequest:', error)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal Server Error' }))
      } else {
        res.destroy()
      }
    }
  }

  const directServer = createServer(handleDirectRequest)
  const servers: Server[] = [directServer]

  if (deps.cfg.ingressPort) {
    const ingressServer = createServer(handleIngressRequest)
    servers.push(ingressServer)
  }

  let closing = false
  return {
    servers,
    close: async () => {
      if (closing) return
      closing = true

      hub.close()
      await ha.stop()

      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close((err) => {
                if (err && 'code' in err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
                  console.error('Error closing server:', err)
                }
                resolve()
              })
            }),
        ),
      )
    },
  }
}
```

Two behavior notes worth calling out explicitly, since they're easy to get subtly wrong:
- The old `allowlist.onChange` re-subscribed HA to exactly that portal's entities; the new version has to union across **every** portal's allowlist before calling `ha.setWatchedEntities`, since Home Assistant has one WebSocket subscription shared by all portals — narrowing it to just the changed portal's entities would silently stop watching another portal's devices the moment any one portal's allowlist is edited.
- The ingress `/api/stream` path (ingress ⇒ automatic admin) now requires `?portalId=` even though it never required any query param before — an admin viewing the portal dropdown must always have a concrete portal selected before the tile grid's stream can open. Task 26 (web `store.ts`) is what actually supplies this on the client side.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/integration/server-process.test.ts test/integration/portal-toggle.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/runtime.ts test/integration/server-process.test.ts test/integration/portal-toggle.test.ts
git commit -m "feat: fan out SSE snapshots and patches per portal"
```

## Phase 5: Server wiring and the neutral login screen

### Task 15: `app.ts` — session-based middleware, portal-aware theming, mount portal routes

**Files:**
- Modify: `src/server/app.ts` (full current contents 175 lines)
- Test: `test/integration/base-href.test.ts`, `test/integration/ingress-security.test.ts`, `test/integration/malformed-paths.test.ts` (existing — update as needed)

**Interfaces:**
- Consumes: `mountPortalRoutes` (Task 10), `SessionData` (Task 7), `resolvePortalId` (Task 9).
- Produces: `Env['Variables']` becomes `{ session: SessionData }` (was `{ role: Role }`).

- [ ] **Step 1: Write the failing test**

Read `test/integration/base-href.test.ts` in full first (it directly exercises `renderIndexHtml`'s injected attributes via a running server). Add:

```ts
it('renders a neutral theme with no session cookie', async () => {
  const res = await fetch(baseUrl)
  const html = await res.text()
  expect(html).toContain('data-theme="classic"') // DEFAULT_THEME_ID — confirm the actual constant's value in src/shared/themes.ts and use that literal here, not a guess
  expect(html).not.toContain('data-portal-title')
})

it('renders the guest\'s own portal theme when their session cookie is valid', async () => {
  const portal = portals.create({ title: 'Timothy', password: 'timothy-theme-pass' })
  portals.update(portal.id, { theme: 'tiles' })
  const cookie = await loginAs('timothy-theme-pass')

  const res = await fetch(baseUrl, { headers: { cookie } })
  const html = await res.text()
  expect(html).toContain('data-theme="tiles"')
  expect(html).toContain(`data-portal-title="Timothy"`)
})

it('escapes a hostile portal title rather than emitting it raw', async () => {
  // The title is owner-supplied text written into two HTML contexts. This
  // is the only injection surface `renderIndexHtml` adds beyond the base
  // href already covered above.
  const portal = portals.create({ title: '"><script>alert(1)</script>', password: 'hostile-title-pass' })
  const cookie = await loginAs('hostile-title-pass')

  const res = await fetch(baseUrl, { headers: { cookie } })
  const html = await res.text()
  expect(html).not.toContain('<script>alert(1)</script>')
  expect(html).not.toContain('data-portal-title="">')
  // Necessary but not sufficient on their own: dropping only the quote
  // replacement still escapes the tag while closing the attribute early —
  // the whole expected value is what proves the attribute survived intact.
  expect(html).toContain('data-portal-title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
  expect(html).toContain('<title>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>')
})

it('escapes an ampersand in the portal title before the escapes it introduces itself', async () => {
  // Ordering matters and is invisible in a title made only of tags: escape
  // `&` last and every `&` this function emits gets re-escaped, so the
  // header renders `&quot;` as literal text instead of a quote.
  const portal = portals.create({ title: 'Tom & Jerry\'s "Place"', password: 'ampersand-title-pass' })
  const cookie = await loginAs('ampersand-title-pass')

  const res = await fetch(baseUrl, { headers: { cookie } })
  const html = await res.text()
  expect(html).toContain('data-portal-title="Tom &amp; Jerry&#39;s &quot;Place&quot;"')
  expect(html).toContain('<title>Tom &amp; Jerry&#39;s &quot;Place&quot;</title>')
  expect(html).not.toContain('Tom & Jerry')
  expect(html).not.toContain('&amp;quot;')
})

it('treats $-sequences in the portal title as text, not replacement patterns', async () => {
  // `String.prototype.replace` expands `$&` and `` $` `` inside a *string*
  // replacement, and escaping does not defuse them: `$&` escapes to
  // `$&amp;`, which still begins `$&`. Only a function replacer disables
  // the expansion — without one the matched `<html` tag would land inside
  // its own attribute value.
  const portal = portals.create({ title: '$& $` Bay', password: 'dollar-title-pass' })
  const cookie = await loginAs('dollar-title-pass')

  const res = await fetch(baseUrl, { headers: { cookie } })
  const html = await res.text()
  expect(html).toContain('data-portal-title="$&amp; $` Bay"')
  expect(html).toContain('<title>$&amp; $` Bay</title>')
  expect(html).not.toMatch(/data-portal-title="[^"]*<(html|!DOCTYPE)/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/integration/base-href.test.ts`
Expected: FAIL — `renderIndexHtml` still calls the now-removed `deps.settings.getTitle()`/`getTheme()`

- [ ] **Step 3: Rewrite `app.ts`**

```ts
import { readFileSync } from 'node:fs'
import { Hono, type MiddlewareHandler, type Context } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import type { HttpBindings } from '@hono/node-server'
import { DEFAULT_THEME_ID } from '../shared/themes.js'
import { createRoutes, resolvePortalId, type Deps } from './http/routes-guest.js'
import { mountAdminRoutes } from './http/routes-admin.js'
import { mountPortalRoutes } from './http/routes-portals.js'
import { mountIntegrationRoutes } from './http/routes-integration.js'
import { checkSession, isFromSupervisor } from './runtime.js'
import type { SessionData } from './http/auth.js'

export type Env = {
  Bindings: HttpBindings
  Variables: {
    session: SessionData
  }
}

const DEFAULT_WEB_ROOT = './dist/web'

function webRootFor(deps: Deps): string {
  return deps.cfg.webRoot ?? DEFAULT_WEB_ROOT
}

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

/**
 * A pre-login request has no portal to theme for — there is no session cookie
 * yet, and Home Assistant's own frontend serving the ingress iframe hits this
 * same route as an admin who has not yet picked a portal from the dropdown.
 * Both get the neutral default theme and no title override; a reload after a
 * successful login re-renders themed, once there is a session to resolve.
 */
function themeAndTitleFor(
  deps: Deps,
  session: SessionData | null,
): { theme: string; title: string | null } {
  if (session === null) return { theme: DEFAULT_THEME_ID, title: null }

  if (session.role === 'guest') {
    const portal = deps.portals.get(session.portalId)
    if (portal === null) return { theme: DEFAULT_THEME_ID, title: null }
    return { theme: portal.theme, title: portal.title }
  }

  const lastSelected = deps.settings.getLastSelectedPortalId()
  const portal = lastSelected === null ? null : deps.portals.get(lastSelected)
  if (portal === null) return { theme: DEFAULT_THEME_ID, title: null }
  return { theme: portal.theme, title: portal.title }
}

function renderIndexHtml(deps: Deps, baseHref: string, session: SessionData | null): string | null {
  let html: string
  try {
    html = readFileSync(`${webRootFor(deps)}/index.html`, 'utf-8')
  } catch {
    return null
  }

  const normalizedBase = baseHref.endsWith('/') ? baseHref : `${baseHref}/`
  const escapedBase = escapeHtml(normalizedBase)
  const { theme, title } = themeAndTitleFor(deps, session)

  let html2 = html
    .replace(/(<head[^>]*>)/i, (head) => `${head}\n    <base href="${escapedBase}">`)
    .replace(
      /<html/i,
      () => `<html data-theme="${theme}" data-ingress-base="${escapedBase}"`,
    )

  // The two title-bearing replacements take a *function*, not a string. A
  // string replacement expands `$&`, `` $` `` and `$'`, and escaping does not
  // defuse them — `$&` escapes to `$&amp;`, which still starts `$&` — so a
  // title containing one would splice the matched tag into its own attribute.
  if (title !== null) {
    const escapedTitle = escapeHtml(title)
    html2 = html2
      .replace(/<html([^>]*)>/i, (_full, attrs: string) => `<html${attrs} data-portal-title="${escapedTitle}">`)
      .replace(/<title>[^<]*<\/title>/i, () => `<title>${escapedTitle}</title>`)
  }

  return html2
}

function baseHrefFor(c: Context<Env>, deps: Deps): string {
  const remoteAddress = c.env.incoming.socket.remoteAddress
  const isIngress = deps.cfg.ingressPort && isFromSupervisor(remoteAddress)
  return isIngress ? (c.req.header('x-ingress-path') ?? '/') : '/'
}

function sessionFromRequest(c: Context<Env>, deps: Deps): SessionData | null {
  const remoteAddress = c.env.incoming.socket.remoteAddress
  if (deps.cfg.ingressPort && isFromSupervisor(remoteAddress)) {
    return { role: 'admin', expiresAt: Number.POSITIVE_INFINITY }
  }
  return checkSession(c.req.header('cookie'), deps.sessions)
}

export function createApp(deps: Deps) {
  const app = new Hono<Env>()

  const ingressMiddleware: MiddlewareHandler<Env> = async (c, next) => {
    const remoteAddress = c.env.incoming.socket.remoteAddress

    if (deps.cfg.ingressPort && isFromSupervisor(remoteAddress)) {
      c.set('session', { role: 'admin', expiresAt: Number.POSITIVE_INFINITY })
      await next()
      return
    }

    await next()
  }

  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    const existing = c.get('session')
    if (existing) {
      await next()
      return
    }

    const session = checkSession(c.req.header('cookie'), deps.sessions)

    if (!session) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    c.set('session', session)
    await next()
  }

  app.use('*', ingressMiddleware)

  const routes = createRoutes(deps)

  app.post('/api/login', routes.login)
  app.post('/api/logout', routes.logout)
  app.get('/api/health', routes.health)

  mountIntegrationRoutes(app, deps)

  app.get('/api/session', requireSession, routes.session)
  app.get('/api/devices', requireSession, routes.devices)
  app.post('/api/devices/:entityId/:action', requireSession, routes.callAction)
  // /api/stream is handled in runtime.ts before Hono sees it

  app.use('/api/admin/*', requireSession)
  mountAdminRoutes(app, deps)
  mountPortalRoutes(app, deps)

  app.get('/', (c) => {
    const session = sessionFromRequest(c, deps)
    const html = renderIndexHtml(deps, baseHrefFor(c, deps), session)
    return html === null ? c.notFound() : c.html(html)
  })

  app.get('/index.html', (c) => {
    const session = sessionFromRequest(c, deps)
    const html = renderIndexHtml(deps, baseHrefFor(c, deps), session)
    return html === null ? c.notFound() : c.html(html)
  })

  app.use('/*', serveStatic({ root: webRootFor(deps) }))

  app.use('/*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.notFound()
    }

    const session = sessionFromRequest(c, deps)
    const html = renderIndexHtml(deps, baseHrefFor(c, deps), session)
    return html === null ? c.notFound() : c.html(html)
  })

  return app
}
```

`resolvePortalId` is imported here only to keep the import list matching what `routes-guest.ts` exports for other consumers to pick up — this file itself does not call it directly (guest/admin devices routes call it internally within `routes-guest.ts`'s own handlers, Task 9). If lint flags the unused import, remove it — it is not required by this file's own logic, only mentioned above for readers tracing where the helper is used across the codebase.

- [ ] **Step 3b: Remove Task 9's interim `currentSession` shim from `routes-guest.ts`**

Task 9 (Phase 3) needed a session object before this file (`app.ts`) existed in its new form — at that point in the plan's sequencing, `Env['Variables']` still only had `role: Role`, not `session: SessionData`, so `routes-guest.ts` could not yet reference `c.var.session` directly. Its implementer worked around this with a local helper:

```ts
function currentSession(c: HonoContext): SessionData | undefined {
  return c.get('role') as unknown as SessionData | undefined
}
```

This shim has a real bug that was never reachable in Task 9's own tests (which never configure an ingress port): the ingress admin path sets a bare string, `c.set('role', 'admin')` (see the *old* `ingressMiddleware` this very step just replaced), not a `SessionData` object — so `currentSession(c)` would silently produce a broken pseudo-session (`.role` reading `undefined`, not `'admin'`) for any ingress-sourced request, until this exact step lands. Now that this step's `Env['Variables']` genuinely has `session: SessionData`, and the new `ingressMiddleware`/`requireSession` both call `c.set('session', ...)` with a real object in every code path (no more bare strings), the shim is no longer needed and its bug is moot going forward — but only if it is actually removed:

1. In `src/server/http/routes-guest.ts`, delete the `currentSession` function entirely (including its doc comment).
2. Replace every `const session = currentSession(c)` call site with `const session = c.var.session`.
3. `src/server/http/routes-admin.ts` (Task 11) carries the same interim shim in its admin-role middleware (`const session = c.get('role') as unknown as SessionData | undefined`, with a comment pointing at this exact step) — replace it with `const session = c.var.session` too, and drop the now-unnecessary `SessionData` type-only cast import if nothing else in that file still needs it.
4. Run `pnpm typecheck` — both files should now compile cleanly with no cast, since `c.var.session` is properly typed as `SessionData | undefined` once each file's own `Env` import resolves against the `app.ts` you just wrote.
5. Run `pnpm vitest run test/integration/routes-guest.test.ts test/integration/routes-admin.test.ts` to confirm nothing regressed (should still be fully green — this is a pure refactor, no behavior change for the cookie-based path, and a real bug fix for the ingress path).

```bash
git add src/server/http/routes-guest.ts src/server/http/routes-admin.ts
git commit -m "refactor: read the session context variable directly now that app.ts provides it"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/integration/base-href.test.ts test/integration/ingress-security.test.ts test/integration/malformed-paths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/app.ts test/integration/base-href.test.ts test/integration/ingress-security.test.ts test/integration/malformed-paths.test.ts
git commit -m "feat: theme the pre-login page neutrally, theme post-login by resolved portal"
```

At this point the entire server side should compile and pass its full suite. Run `pnpm vitest run && pnpm typecheck && pnpm lint` before moving to Phase 6 and treat any remaining red as a real gap in this plan, not something to defer further.

## Phase 6: Web app

### Task 16: `web/api.ts` — portal endpoints, portal-scoped admin calls

**Files:**
- Modify: `src/web/api.ts` (full current contents 248 lines)
- Test: `test/unit/web-api.test.ts` (existing — update it; recall from the earlier ingress-fix work this file runs under `happy-dom` via a `// @vitest-environment happy-dom` directive and already has a pattern for asserting on `fetch`'s called URL)

**Interfaces:**
- Produces: `getSession(): Promise<z.infer<typeof SessionResponse> | null>` (was `{ role, portalEnabled } | null` — now the full discriminated union or `null` on 401). `login(password): Promise<ApiResult<z.infer<typeof SessionResponse>>>`. New: `getPortals(): Promise<ApiResult<{ portals: PortalSummary[]; lastSelectedPortalId: string | null }>>`, `createPortal(input: { title: string; password: string }): Promise<ApiResult<PortalDetail>>`, `getPortal(id): Promise<ApiResult<PortalDetail>>`, `updatePortal(id, patch): Promise<ApiResult<PortalDetail>>`, `deletePortal(id): Promise<ApiResult<void>>`, `getPortalAllowlist(portalId): Promise<ApiResult<{devices, orphaned}>>`, `putPortalAllowlist(portalId, devices): Promise<ApiResult<void>>`, `getDeploymentSettings(): Promise<ApiResult<{integrationToken, deploymentId}>>`, `putLastSelectedPortal(portalId): Promise<ApiResult<void>>`. `getDevices(portalId?: string)`/`performAction(entityId, action, portalId?: string)` gain an optional trailing `portalId` that, when present, is appended as `?portalId=` (used only by admin call sites; guest call sites omit it since their portal is implied by session). **Removed:** `getAllowlist`, `putAllowlist`, `getAdminPortal`, `putAdminPortal`, `putAdminTheme`, `putAdminTitle`.

- [ ] **Step 1: Write the failing test**

Read `test/unit/web-api.test.ts` in full first. Replace tests for the removed functions with:

```ts
it('getPortals fetches the portal list with the ingress-prefixed URL', async () => {
  document.documentElement.dataset.ingressBase = '/api/hassio_ingress/tok/'
  const mockFetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ portals: [], lastSelectedPortalId: null }), { status: 200 }),
  )
  vi.stubGlobal('fetch', mockFetch)

  await getPortals()

  expect(mockFetch).toHaveBeenCalledWith(
    '/api/hassio_ingress/tok/api/admin/portals',
    expect.anything(),
  )
})

it('createPortal posts title and password', async () => {
  const mockFetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'p1', title: 'Timothy', theme: 'classic', enabled: true, password: 'x' }), {
      status: 200,
    }),
  )
  vi.stubGlobal('fetch', mockFetch)

  const result = await createPortal({ title: 'Timothy', password: 'a-secret' })

  expect(result.ok).toBe(true)
  const [, init] = mockFetch.mock.calls[0]
  expect(init.method).toBe('POST')
  expect(JSON.parse(init.body)).toEqual({ title: 'Timothy', password: 'a-secret' })
})

it('getDevices appends portalId when given one', async () => {
  const mockFetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ devices: [], stale: false }), { status: 200 }),
  )
  vi.stubGlobal('fetch', mockFetch)

  await getDevices('portal-123')

  expect(mockFetch.mock.calls[0][0]).toBe('/api/devices?portalId=portal-123')
})

it('getDevices omits portalId when not given one', async () => {
  const mockFetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ devices: [], stale: false }), { status: 200 }),
  )
  vi.stubGlobal('fetch', mockFetch)

  await getDevices()

  expect(mockFetch.mock.calls[0][0]).toBe('/api/devices')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/web-api.test.ts`
Expected: FAIL — `getPortals`/`createPortal` don't exist; `getDevices` takes no arguments today

- [ ] **Step 3: Rewrite `api.ts`**

Full new contents:

```ts
import type { z } from 'zod'
import { apiUrl } from './basePath.js'
import {
  AllowlistPutRequest,
  type AllowlistRow,
  AllowlistResponse,
  type CatalogEntry,
  CatalogResponse,
  DeploymentSettingsResponse,
  DevicesResponse,
  LastSelectedPortalPutRequest,
  PortalCreateRequest,
  PortalDetailResponse,
  PortalPutRequest,
  PortalsListResponse,
  SessionResponse,
} from '@shared/api.js'

type ApiSuccess<T> = { ok: true; data: T }
type ApiError = { ok: false; status: number; retryAfter: number } | { ok: false; status: number }
type ApiResult<T> = ApiSuccess<T> | ApiError

let unauthorizedCallback: (() => void) | null = null

export function setUnauthorizedCallback(callback: (() => void) | null): void {
  unauthorizedCallback = callback
}

async function handleResponse<T>(
  response: Response,
  schema: { parse: (data: unknown) => T },
): Promise<ApiResult<T>> {
  if (!response.ok) {
    if (response.status === 401 && unauthorizedCallback !== null) {
      unauthorizedCallback()
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After')
      if (retryAfterHeader) {
        const retryAfter = Number.parseInt(retryAfterHeader, 10)
        if (!Number.isNaN(retryAfter) && retryAfter >= 0) {
          return { ok: false, status: response.status, retryAfter }
        }
      }
    }

    return { ok: false, status: response.status }
  }

  const json = await response.json()
  const parsed = schema.parse(json)
  return { ok: true, data: parsed }
}

function withPortalId(path: string, portalId?: string): string {
  return portalId === undefined ? path : `${path}?portalId=${encodeURIComponent(portalId)}`
}

export async function login(
  password: string,
): Promise<ApiResult<z.infer<typeof SessionResponse>>> {
  const response = await fetch(apiUrl('/api/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    credentials: 'same-origin',
  })

  return handleResponse(response, SessionResponse)
}

export async function logout(): Promise<void> {
  await fetch(apiUrl('/api/logout'), { method: 'POST', credentials: 'same-origin' })
}

export async function getSession(): Promise<z.infer<typeof SessionResponse> | null> {
  const response = await fetch(apiUrl('/api/session'), { credentials: 'same-origin' })

  if (response.status === 401) {
    return null
  }

  const json = await response.json()
  return SessionResponse.parse(json)
}

export async function getDevices(portalId?: string): Promise<ApiResult<z.infer<typeof DevicesResponse>>> {
  const response = await fetch(apiUrl(withPortalId('/api/devices', portalId)), {
    credentials: 'same-origin',
  })

  return handleResponse(response, DevicesResponse)
}

export async function performAction(
  entityId: string,
  action: string,
  portalId?: string,
): Promise<ApiResult<void>> {
  const response = await fetch(
    apiUrl(withPortalId(`/api/devices/${entityId}/${action}`, portalId)),
    { method: 'POST', credentials: 'same-origin' },
  )

  if (!response.ok) {
    if (response.status === 401 && unauthorizedCallback !== null) {
      unauthorizedCallback()
    }
    return { ok: false, status: response.status }
  }

  return { ok: true, data: undefined }
}

export async function getCatalog(): Promise<ApiResult<CatalogEntry[]>> {
  const response = await fetch(apiUrl('/api/admin/entities'), { credentials: 'same-origin' })
  const result = await handleResponse(response, CatalogResponse)
  if (!result.ok) return result
  return { ok: true, data: result.data.entities }
}

export async function getPortals(): Promise<
  ApiResult<z.infer<typeof PortalsListResponse>>
> {
  const response = await fetch(apiUrl('/api/admin/portals'), { credentials: 'same-origin' })
  return handleResponse(response, PortalsListResponse)
}

export async function createPortal(
  input: z.infer<typeof PortalCreateRequest>,
): Promise<ApiResult<z.infer<typeof PortalDetailResponse>>> {
  const response = await fetch(apiUrl('/api/admin/portals'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'same-origin',
  })
  return handleResponse(response, PortalDetailResponse)
}

export async function getPortal(
  portalId: string,
): Promise<ApiResult<z.infer<typeof PortalDetailResponse>>> {
  const response = await fetch(apiUrl(`/api/admin/portals/${portalId}`), {
    credentials: 'same-origin',
  })
  return handleResponse(response, PortalDetailResponse)
}

export async function updatePortal(
  portalId: string,
  patch: z.infer<typeof PortalPutRequest>,
): Promise<ApiResult<z.infer<typeof PortalDetailResponse>>> {
  const response = await fetch(apiUrl(`/api/admin/portals/${portalId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    credentials: 'same-origin',
  })
  return handleResponse(response, PortalDetailResponse)
}

export async function deletePortal(portalId: string): Promise<ApiResult<void>> {
  const response = await fetch(apiUrl(`/api/admin/portals/${portalId}`), {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  if (!response.ok) return { ok: false, status: response.status }
  return { ok: true, data: undefined }
}

export async function getPortalAllowlist(
  portalId: string,
): Promise<ApiResult<{ devices: AllowlistRow[]; orphaned: string[] }>> {
  const response = await fetch(apiUrl(`/api/admin/portals/${portalId}/allowlist`), {
    credentials: 'same-origin',
  })
  return handleResponse(response, AllowlistResponse)
}

export async function putPortalAllowlist(
  portalId: string,
  devices: AllowlistRow[],
): Promise<ApiResult<void>> {
  const response = await fetch(apiUrl(`/api/admin/portals/${portalId}/allowlist`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(AllowlistPutRequest.parse({ devices })),
    credentials: 'same-origin',
  })
  if (!response.ok) {
    if (response.status === 401 && unauthorizedCallback !== null) unauthorizedCallback()
    return { ok: false, status: response.status }
  }
  return { ok: true, data: undefined }
}

export async function getDeploymentSettings(): Promise<
  ApiResult<z.infer<typeof DeploymentSettingsResponse>>
> {
  const response = await fetch(apiUrl('/api/admin/settings'), { credentials: 'same-origin' })
  return handleResponse(response, DeploymentSettingsResponse)
}

export async function putLastSelectedPortal(portalId: string): Promise<ApiResult<void>> {
  const response = await fetch(apiUrl('/api/admin/last-selected-portal'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(LastSelectedPortalPutRequest.parse({ portalId })),
    credentials: 'same-origin',
  })
  if (!response.ok) return { ok: false, status: response.status }
  return { ok: true, data: undefined }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/web-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/api.ts test/unit/web-api.test.ts
git commit -m "feat: add portal management API calls, scope device calls to a portal"
```

Note: this task also requires amending Task 8/Task 10's work slightly — `PortalsListResponse` needs a `lastSelectedPortalId: string | null` field, and the `GET /api/admin/portals` handler needs to return it, so the admin client can default its dropdown selection without a second round trip. Do this now as part of this task (touching `src/shared/api.ts` and `src/server/http/routes-portals.ts` again):

In `shared/api.ts`, change:
```ts
export const PortalsListResponse = z.object({ portals: z.array(PortalFieldsSchema) })
```
to:
```ts
export const PortalsListResponse = z.object({
  portals: z.array(PortalFieldsSchema),
  lastSelectedPortalId: z.string().nullable(),
})
```

In `routes-portals.ts`, change the `GET /api/admin/portals` handler from:
```ts
app.get('/api/admin/portals', (c) => {
  return c.json(PortalsListResponse.parse({ portals: portals.list() }))
})
```
to:
```ts
app.get('/api/admin/portals', (c) => {
  return c.json(
    PortalsListResponse.parse({
      portals: portals.list(),
      lastSelectedPortalId: settings.getLastSelectedPortalId(),
    }),
  )
})
```

Re-run `pnpm vitest run test/integration/routes-portals.test.ts` after this amendment to confirm Task 10's tests still pass with the added field, then fold this small amendment into this task's commit rather than creating a separate one.

### Task 17: `useAllowlistEditor` — thread a `portalId`

**Files:**
- Modify: `src/web/hooks/useAllowlistEditor.ts` (full current contents 183 lines — only the signature and the one `putAllowlist` call site change)
- Test: `test/unit/allowlist-editor.test.tsx` (existing — update it)

**Interfaces:**
- Produces: `useAllowlistEditor(devices: Device[], portalId: string): AllowlistEditor` (was `(devices: Device[])`).

- [ ] **Step 1: Write the failing test**

Read `test/unit/allowlist-editor.test.tsx` first. Update every `renderHook(() => useAllowlistEditor(two))` call (and similar) to `renderHook(() => useAllowlistEditor(two, 'portal-1'))`, and add:

```ts
it('saves against the given portal id', async () => {
  const { result } = renderHook(() => useAllowlistEditor(two, 'portal-42'))
  act(() => {
    result.current.add({ entityId: 'switch.fan', name: 'Fan', domain: 'switch', supported: true } as CatalogEntry)
  })
  await waitFor(() => expect(api.putPortalAllowlist).toHaveBeenCalled())
  expect(vi.mocked(api.putPortalAllowlist).mock.calls[0]?.[0]).toBe('portal-42')
})
```

(Update the file's `vi.mock('../../src/web/api.js')` / mock setup to mock `putPortalAllowlist` instead of `putAllowlist`, matching Task 16's rename.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/allowlist-editor.test.tsx`
Expected: FAIL — `useAllowlistEditor` still takes one argument and calls the now-removed `putAllowlist`

- [ ] **Step 3: Edit `useAllowlistEditor.ts`**

Change the import line from:
```ts
import { putAllowlist } from '../api.js'
```
to:
```ts
import { putPortalAllowlist } from '../api.js'
```

Change the function signature from:
```ts
export function useAllowlistEditor(devices: Device[]): AllowlistEditor {
```
to:
```ts
export function useAllowlistEditor(devices: Device[], portalId: string): AllowlistEditor {
```

Change the `commit` callback's body from `const result = await putAllowlist(next)` to `const result = await putPortalAllowlist(portalId, next)`, and add `portalId` to its `useCallback` dependency array (`[portalId]`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/allowlist-editor.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/hooks/useAllowlistEditor.ts test/unit/allowlist-editor.test.tsx
git commit -m "feat: scope the allowlist editor's saves to a portal"
```

### Task 18: `store.ts` — bind the device stream to a portal

**Files:**
- Modify: `src/web/store.ts` (full current contents 194 lines)
- Test: `test/unit/web-store.test.ts` (existing — update it)

**Interfaces:**
- Produces: `connectDeviceStore(portalId: string): () => void` (was `connectDeviceStore()`). Switching portals means tearing down and recreating the connection — this task does not add reconnect-on-switch logic itself (that is Task 24's job, calling `connectDeviceStore` again with a new `portalId` when the admin's `useEffect` dependency changes), it only makes the function accept the parameter it needs.

- [ ] **Step 1: Write the failing test**

Read `test/unit/web-store.test.ts` first. Update calls to `connectDeviceStore()` to `connectDeviceStore('portal-1')`, and add:

```ts
it('opens the stream at the given portal id', () => {
  const originalEventSource = globalThis.EventSource
  const seenUrls: string[] = []
  // @ts-expect-error test stub
  globalThis.EventSource = class {
    constructor(url: string) {
      seenUrls.push(url)
    }
    addEventListener() {}
    close() {}
  }

  const teardown = connectDeviceStore('portal-99')
  expect(seenUrls[0]).toContain('portalId=portal-99')

  teardown()
  globalThis.EventSource = originalEventSource
})
```

(Adapt to however this test file already stubs `EventSource` — it likely already has a fixture given the existing ingress-fix test added in this same file per the earlier session's work; read it first and reuse that fixture rather than writing a second one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/web-store.test.ts`
Expected: FAIL — `connectDeviceStore` takes no arguments today

- [ ] **Step 3: Edit `store.ts`**

Change:
```ts
export function connectDeviceStore(): () => void {
```
to:
```ts
export function connectDeviceStore(portalId: string): () => void {
```

Change the `EventSource` construction line from:
```ts
eventSource = new EventSource(apiUrl('/api/stream'), { withCredentials: true })
```
to:
```ts
eventSource = new EventSource(apiUrl(`/api/stream?portalId=${encodeURIComponent(portalId)}`), {
  withCredentials: true,
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/web-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/store.ts test/unit/web-store.test.ts
git commit -m "feat: bind the device stream to a portal id"
```

### Task 19: `CreatePortalScreen` component

**Files:**
- Create: `src/web/components/CreatePortalScreen.tsx`
- Test: `test/unit/create-portal-screen.test.tsx` (new)

**Interfaces:**
- Produces: `CreatePortalScreen({ onCreated }: { onCreated: (portal: PortalDetail) => void }): ReactElement` — a title + password form (password masked with a show/hide toggle, per the spec's password-field UX decision), calling `createPortal` (Task 16) on submit and invoking `onCreated` with the result. Used both full-page (zero portals) and inside an overlay (Task 24, "+ Add portal").

- [ ] **Step 1: Write the failing test**

```tsx
// test/unit/create-portal-screen.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../../src/web/api.js'
import { CreatePortalScreen } from '../../src/web/components/CreatePortalScreen.js'

vi.mock('../../src/web/api.js')

describe('CreatePortalScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a portal with the entered title and password', async () => {
    const user = userEvent.setup()
    const created = { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true, password: 'a-secret' }
    vi.mocked(api.createPortal).mockResolvedValue({ ok: true, data: created })
    const onCreated = vi.fn()

    render(<CreatePortalScreen onCreated={onCreated} />)

    await user.type(screen.getByLabelText(/portal name/i), 'Timothy')
    await user.type(screen.getByLabelText(/^password$/i), 'a-secret')
    await user.click(screen.getByRole('button', { name: /create/i }))

    await waitFor(() =>
      expect(api.createPortal).toHaveBeenCalledWith({ title: 'Timothy', password: 'a-secret' }),
    )
    expect(onCreated).toHaveBeenCalledWith(created)
  })

  it('the password field is masked by default and reveals on click', async () => {
    const user = userEvent.setup()
    render(<CreatePortalScreen onCreated={vi.fn()} />)

    const passwordField = screen.getByLabelText(/^password$/i)
    expect(passwordField).toHaveAttribute('type', 'password')

    await user.click(screen.getByRole('button', { name: /show password/i }))
    expect(passwordField).toHaveAttribute('type', 'text')
  })

  it('shows a server error, e.g. a duplicate password, without crashing', async () => {
    const user = userEvent.setup()
    vi.mocked(api.createPortal).mockResolvedValue({ ok: false, status: 409 })

    render(<CreatePortalScreen onCreated={vi.fn()} />)
    await user.type(screen.getByLabelText(/portal name/i), 'Timothy')
    await user.type(screen.getByLabelText(/^password$/i), 'taken-pass')
    await user.click(screen.getByRole('button', { name: /create/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not create/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/create-portal-screen.test.tsx`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write `CreatePortalScreen.tsx`**

```tsx
import type { CSSProperties, ReactElement } from 'react'
import { useState } from 'react'
import type { z } from 'zod'
import type { PortalDetailResponse } from '@shared/api.js'
import { createPortal } from '../api.js'

type PortalDetail = z.infer<typeof PortalDetailResponse>

export type CreatePortalScreenProps = {
  onCreated: (portal: PortalDetail) => void
}

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  maxWidth: '360px',
  margin: '64px auto',
  padding: 'var(--tilePadding)',
  backgroundColor: 'var(--surface)',
  color: 'var(--text)',
  fontFamily: 'var(--fontFamily)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

const fieldLabel: CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 500,
  marginBottom: '4px',
  color: 'var(--textMuted)',
}

const textInput: CSSProperties = {
  width: '100%',
  padding: '8px',
  fontSize: '14px',
  fontFamily: 'inherit',
  color: 'var(--text)',
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

const passwordRow: CSSProperties = { display: 'flex', gap: '8px' }

const revealButton: CSSProperties = {
  padding: '4px 8px',
  fontSize: '12px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  backgroundColor: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

const submitButton: CSSProperties = {
  padding: '10px 16px',
  fontSize: '14px',
  fontWeight: 500,
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--accentText)',
  backgroundColor: 'var(--accent)',
  border: 'none',
  borderRadius: 'var(--tileRadius)',
}

const errorText: CSSProperties = { margin: 0, fontSize: '13px', color: 'var(--danger)' }

export function CreatePortalScreen({ onCreated }: CreatePortalScreenProps): ReactElement {
  const [title, setTitle] = useState('')
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(): Promise<void> {
    setSubmitting(true)
    setError(null)

    let result: Awaited<ReturnType<typeof createPortal>>
    try {
      result = await createPortal({ title, password })
    } catch {
      setSubmitting(false)
      setError('Could not create the portal')
      return
    }

    setSubmitting(false)

    if (!result.ok) {
      setError(
        result.status === 409
          ? 'Could not create the portal — that password is already in use'
          : 'Could not create the portal',
      )
      return
    }

    onCreated(result.data)
  }

  return (
    <div style={wrap}>
      <h1 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>Create a portal</h1>

      <div>
        <label htmlFor="create-portal-title" style={fieldLabel}>
          Portal name
        </label>
        <input
          id="create-portal-title"
          type="text"
          style={textInput}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="create-portal-password" style={fieldLabel}>
          Password
        </label>
        <div style={passwordRow}>
          <input
            id="create-portal-password"
            type={revealed ? 'text' : 'password'}
            style={textInput}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            style={revealButton}
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? 'Hide password' : 'Show password'}
          </button>
        </div>
      </div>

      {error !== null && (
        <p role="alert" style={errorText}>
          {error}
        </p>
      )}

      <button
        type="button"
        style={submitButton}
        disabled={submitting || title.trim() === '' || password.trim() === ''}
        onClick={() => {
          void handleSubmit()
        }}
      >
        {submitting ? 'Creating…' : 'Create portal'}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/create-portal-screen.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/components/CreatePortalScreen.tsx test/unit/create-portal-screen.test.tsx
git commit -m "feat: add the create-portal screen"
```

### Task 20: `PortalDropdown` component

**Files:**
- Create: `src/web/components/PortalDropdown.tsx`
- Test: `test/unit/portal-dropdown.test.tsx` (new)

**Interfaces:**
- Produces: `PortalDropdown({ portals, selectedId, onSelect, onAddPortal }: { portals: PortalSummary[]; selectedId: string; onSelect: (id: string) => void; onAddPortal: () => void }): ReactElement`. A native `<select>` (cheapest way to get full keyboard/screen-reader support for free) listing each portal's title, with a trailing `+ Add portal` option that calls `onAddPortal` instead of `onSelect` when chosen.

- [ ] **Step 1: Write the failing test**

```tsx
// test/unit/portal-dropdown.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PortalDropdown } from '../../src/web/components/PortalDropdown.js'

const PORTALS = [
  { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true },
  { id: 'p2', title: 'Mary', theme: 'tiles', enabled: true },
]

describe('PortalDropdown', () => {
  it('lists every portal and the current selection', () => {
    render(<PortalDropdown portals={PORTALS} selectedId="p2" onSelect={vi.fn()} onAddPortal={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: /portal/i })
    expect(select).toHaveValue('p2')
    expect(screen.getByRole('option', { name: 'Timothy' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Mary' })).toBeInTheDocument()
  })

  it('calls onSelect when switching to another portal', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<PortalDropdown portals={PORTALS} selectedId="p2" onSelect={onSelect} onAddPortal={vi.fn()} />)

    await user.selectOptions(screen.getByRole('combobox', { name: /portal/i }), 'Timothy')

    expect(onSelect).toHaveBeenCalledWith('p1')
  })

  it('calls onAddPortal, not onSelect, when choosing the trailing option', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onAddPortal = vi.fn()
    render(<PortalDropdown portals={PORTALS} selectedId="p2" onSelect={onSelect} onAddPortal={onAddPortal} />)

    await user.selectOptions(screen.getByRole('combobox', { name: /portal/i }), '+ Add portal')

    expect(onAddPortal).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/portal-dropdown.test.tsx`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write `PortalDropdown.tsx`**

```tsx
import type { CSSProperties, ReactElement } from 'react'
import type { z } from 'zod'
import type { PortalSummaryResponse } from '@shared/api.js'

// Derived from the same schema the server responds with (Task 8), rather than
// a second hand-written shape that could drift from it.
export type PortalSummary = z.infer<typeof PortalSummaryResponse>

export type PortalDropdownProps = {
  portals: PortalSummary[]
  selectedId: string
  onSelect: (id: string) => void
  onAddPortal: () => void
}

const ADD_PORTAL_VALUE = '__add_portal__'

const select: CSSProperties = {
  fontSize: '24px',
  fontWeight: 700,
  fontFamily: 'inherit',
  color: 'var(--text)',
  backgroundColor: 'transparent',
  border: 'none',
  cursor: 'pointer',
}

export function PortalDropdown({
  portals,
  selectedId,
  onSelect,
  onAddPortal,
}: PortalDropdownProps): ReactElement {
  return (
    <select
      aria-label="Portal"
      style={select}
      value={selectedId}
      onChange={(e) => {
        if (e.target.value === ADD_PORTAL_VALUE) {
          onAddPortal()
          return
        }
        onSelect(e.target.value)
      }}
    >
      {portals.map((portal) => (
        <option key={portal.id} value={portal.id}>
          {portal.title}
        </option>
      ))}
      <option value={ADD_PORTAL_VALUE}>+ Add portal</option>
    </select>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/portal-dropdown.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/components/PortalDropdown.tsx test/unit/portal-dropdown.test.tsx
git commit -m "feat: add the portal switcher dropdown"
```

### Task 21: `PortalSettingsAccordion` component

**Files:**
- Create: `src/web/components/PortalSettingsAccordion.tsx`
- Delete: `src/web/components/PortalTitleField.tsx`, `src/web/components/ThemePicker.tsx`, `src/web/components/PortalToggle.tsx` (their responsibilities — title, theme, enable — are absorbed into this one portal-scoped component; their self-fetching-independently design was built for the old single-global-settings-panel and does not fit "one already-known portal's fields shown inline")
- Delete test files: `test/unit/portal-title-field.test.tsx`, `test/unit/theme-picker.test.tsx`, `test/unit/portal-toggle.test.tsx` if they exist (grep for them; their coverage is superseded by this task's test file)
- Test: `test/unit/portal-settings-accordion.test.tsx` (new)

**Interfaces:**
- Consumes: `getPortal`, `updatePortal`, `deletePortal` (Task 16).
- Produces: `PortalSettingsAccordion({ portalId, onUpdated, onDeleted }: { portalId: string; onUpdated: (portal: PortalDetail) => void; onDeleted: () => void }): ReactElement` — collapsed by default, expands to title/theme/enabled/password/delete.

- [ ] **Step 1: Write the failing test**

```tsx
// test/unit/portal-settings-accordion.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../../src/web/api.js'
import { PortalSettingsAccordion } from '../../src/web/components/PortalSettingsAccordion.js'

vi.mock('../../src/web/api.js')

const PORTAL = { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true, password: 'orig-pass' }

describe('PortalSettingsAccordion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getPortal).mockResolvedValue({ ok: true, data: PORTAL })
  })

  it('starts collapsed, expands on click, and loads the portal', async () => {
    render(<PortalSettingsAccordion portalId="p1" onUpdated={vi.fn()} onDeleted={vi.fn()} />)

    expect(screen.queryByLabelText(/portal name/i)).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /portal settings/i }))

    expect(await screen.findByDisplayValue('Timothy')).toBeInTheDocument()
  })

  it('the password is masked by default and reveals on click', async () => {
    const user = userEvent.setup()
    render(<PortalSettingsAccordion portalId="p1" onUpdated={vi.fn()} onDeleted={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /portal settings/i }))

    const passwordField = await screen.findByLabelText(/^password$/i)
    expect(passwordField).toHaveAttribute('type', 'password')

    await user.click(screen.getByRole('button', { name: /show password/i }))
    expect(passwordField).toHaveAttribute('type', 'text')
  })

  it('saves a title change on blur', async () => {
    const user = userEvent.setup()
    vi.mocked(api.updatePortal).mockResolvedValue({ ok: true, data: { ...PORTAL, title: 'Tim' } })
    const onUpdated = vi.fn()

    render(<PortalSettingsAccordion portalId="p1" onUpdated={onUpdated} onDeleted={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /portal settings/i }))

    const field = await screen.findByLabelText(/portal name/i)
    await user.clear(field)
    await user.type(field, 'Tim')
    await user.tab()

    await waitFor(() => expect(api.updatePortal).toHaveBeenCalledWith('p1', { title: 'Tim' }))
    expect(onUpdated).toHaveBeenCalledWith({ ...PORTAL, title: 'Tim' })
  })

  it('requires a confirm click before deleting', async () => {
    const user = userEvent.setup()
    vi.mocked(api.deletePortal).mockResolvedValue({ ok: true, data: undefined })
    const onDeleted = vi.fn()

    render(<PortalSettingsAccordion portalId="p1" onUpdated={vi.fn()} onDeleted={onDeleted} />)
    await user.click(screen.getByRole('button', { name: /portal settings/i }))
    await screen.findByDisplayValue('Timothy')

    await user.click(screen.getByRole('button', { name: /^delete portal$/i }))
    expect(api.deletePortal).not.toHaveBeenCalled()

    await user.click(await screen.findByRole('button', { name: /confirm delete/i }))
    await waitFor(() => expect(api.deletePortal).toHaveBeenCalledWith('p1'))
    expect(onDeleted).toHaveBeenCalled()
  })

  it('shows a duplicate-password error without crashing', async () => {
    const user = userEvent.setup()
    vi.mocked(api.updatePortal).mockResolvedValue({ ok: false, status: 409 })

    render(<PortalSettingsAccordion portalId="p1" onUpdated={vi.fn()} onDeleted={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /portal settings/i }))

    const passwordField = await screen.findByLabelText(/^password$/i)
    await user.clear(passwordField)
    await user.type(passwordField, 'taken-pass')
    await user.tab()

    expect(await screen.findByRole('alert')).toHaveTextContent(/already in use/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/portal-settings-accordion.test.tsx`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write `PortalSettingsAccordion.tsx`**

```tsx
import type { CSSProperties, ReactElement } from 'react'
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import type { PortalDetailResponse } from '@shared/api.js'
import { isThemeId, type ThemeId } from '@shared/themes.js'
import { deletePortal, getPortal, updatePortal } from '../api.js'
import { listThemes } from '../themes/registry.js'

type PortalDetail = z.infer<typeof PortalDetailResponse>

export type PortalSettingsAccordionProps = {
  portalId: string
  onUpdated: (portal: PortalDetail) => void
  onDeleted: () => void
}

const toggleButton: CSSProperties = {
  width: '100%',
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: '14px',
  fontWeight: 500,
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

const body: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  padding: '16px',
  marginTop: '8px',
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

const fieldLabel: CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 500,
  marginBottom: '4px',
  color: 'var(--textMuted)',
}

const textInput: CSSProperties = {
  width: '100%',
  padding: '8px',
  fontSize: '14px',
  fontFamily: 'inherit',
  color: 'var(--text)',
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

const smallButton: CSSProperties = {
  padding: '6px 12px',
  fontSize: '13px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  backgroundColor: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

const dangerButton: CSSProperties = {
  ...smallButton,
  color: 'var(--danger)',
  borderColor: 'var(--danger)',
}

const errorText: CSSProperties = { margin: 0, fontSize: '13px', color: 'var(--danger)' }

export function PortalSettingsAccordion({
  portalId,
  onUpdated,
  onDeleted,
}: PortalSettingsAccordionProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [portal, setPortal] = useState<PortalDetail | null>(null)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [passwordDraft, setPasswordDraft] = useState<string | null>(null)
  const [passwordRevealed, setPasswordRevealed] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!expanded || portal !== null) return
    let cancelled = false

    async function load(): Promise<void> {
      const result = await getPortal(portalId)
      if (cancelled) return
      if (!result.ok) {
        setError('Could not load this portal')
        return
      }
      setPortal(result.data)
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [expanded, portal, portalId])

  async function applyPatch(patch: { title?: string; theme?: ThemeId; enabled?: boolean; password?: string }): Promise<void> {
    setError(null)
    const result = await updatePortal(portalId, patch)
    if (!result.ok) {
      setError(
        result.status === 409
          ? 'Could not save — that password is already in use'
          : 'Could not save that change',
      )
      return
    }
    setPortal(result.data)
    onUpdated(result.data)
  }

  function commitTitle(): void {
    if (titleDraft === null || portal === null || titleDraft === portal.title) {
      setTitleDraft(null)
      return
    }
    const next = titleDraft
    setTitleDraft(null)
    void applyPatch({ title: next })
  }

  function commitPassword(): void {
    if (passwordDraft === null || portal === null || passwordDraft === portal.password) {
      setPasswordDraft(null)
      return
    }
    const next = passwordDraft
    setPasswordDraft(null)
    void applyPatch({ password: next })
  }

  async function handleDelete(): Promise<void> {
    const result = await deletePortal(portalId)
    if (!result.ok) {
      setError('Could not delete this portal')
      return
    }
    onDeleted()
  }

  return (
    <div>
      <button
        type="button"
        style={toggleButton}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? '▾' : '▸'} Portal settings
      </button>

      {expanded && (
        <div style={body}>
          {portal === null ? (
            <p>Loading…</p>
          ) : (
            <>
              <div>
                <label htmlFor="portal-settings-title" style={fieldLabel}>
                  Portal name
                </label>
                <input
                  id="portal-settings-title"
                  type="text"
                  style={textInput}
                  value={titleDraft ?? portal.title}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitTitle}
                />
              </div>

              <div role="radiogroup" aria-label="Theme" style={{ display: 'flex', gap: '12px' }}>
                {listThemes().map((theme) => (
                  <label key={theme.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input
                      type="radio"
                      name="portal-settings-theme"
                      checked={theme.id === portal.theme}
                      onChange={() => {
                        if (isThemeId(theme.id)) void applyPatch({ theme: theme.id })
                      }}
                    />
                    {theme.name}
                  </label>
                ))}
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={portal.enabled}
                  onChange={() => void applyPatch({ enabled: !portal.enabled })}
                />
                {portal.enabled ? 'Enabled — guests can log in' : 'Disabled — guests are blocked'}
              </label>

              <div>
                <label htmlFor="portal-settings-password" style={fieldLabel}>
                  Password
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    id="portal-settings-password"
                    type={passwordRevealed ? 'text' : 'password'}
                    style={textInput}
                    value={passwordDraft ?? portal.password}
                    onChange={(e) => setPasswordDraft(e.target.value)}
                    onBlur={commitPassword}
                  />
                  <button type="button" style={smallButton} onClick={() => setPasswordRevealed((r) => !r)}>
                    {passwordRevealed ? 'Hide password' : 'Show password'}
                  </button>
                </div>
              </div>

              {error !== null && (
                <p role="alert" style={errorText}>
                  {error}
                </p>
              )}

              {confirmingDelete ? (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span style={{ fontSize: '13px' }}>Delete this portal and its device list?</span>
                  <button
                    type="button"
                    style={dangerButton}
                    onClick={() => {
                      void handleDelete()
                    }}
                  >
                    Confirm delete
                  </button>
                  <button type="button" style={smallButton} onClick={() => setConfirmingDelete(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" style={dangerButton} onClick={() => setConfirmingDelete(true)}>
                  Delete portal
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Delete the superseded components and their tests**

```bash
rm src/web/components/PortalTitleField.tsx src/web/components/ThemePicker.tsx src/web/components/PortalToggle.tsx
# Only remove test files that actually exist for these — check first:
git status --short test/unit/*.test.tsx | grep -iE 'portal-title|theme-picker|portal-toggle'
rm -f test/unit/portal-title-field.test.tsx test/unit/theme-picker.test.tsx test/unit/portal-toggle.test.tsx
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/portal-settings-accordion.test.tsx`
Expected: PASS

Run the full suite once here too — deleting three files is exactly the kind of change that leaves a stray import somewhere: `pnpm vitest run && pnpm typecheck`. Fix any remaining reference before continuing (there should be exactly one, `SettingsPanel.tsx`'s import of all three — that file is rewritten in Task 22, so a red `SettingsPanel.tsx` at this exact point in the plan is expected, not a regression to chase down here).

- [ ] **Step 6: Commit**

```bash
git add -A src/web/components/PortalSettingsAccordion.tsx src/web/components/PortalTitleField.tsx src/web/components/ThemePicker.tsx src/web/components/PortalToggle.tsx test/unit/portal-settings-accordion.test.tsx
git commit -m "feat: add the per-portal inline settings accordion"
```

### Task 22: `DeploymentSettingsPanel` — the gear-icon modal (integration token + logout)

**Files:**
- Create: `src/web/components/DeploymentSettingsPanel.tsx`
- Delete: `src/web/components/SettingsPanel.tsx` (its three children are gone per Task 21, and its remaining job — integration token — plus the newly-added admin Logout button becomes this new component)
- Delete test: `test/unit/settings-panel.test.tsx` if it exists (grep first)
- Test: `test/unit/deployment-settings-panel.test.tsx` (new)

**Interfaces:**
- Consumes: `getDeploymentSettings` (Task 16).
- Produces: `DeploymentSettingsPanel({ onClose, onLogout, loggingOut }: { onClose: () => void; onLogout: () => void; loggingOut: boolean }): ReactElement`.

- [ ] **Step 1: Write the failing test**

```tsx
// test/unit/deployment-settings-panel.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../../src/web/api.js'
import { DeploymentSettingsPanel } from '../../src/web/components/DeploymentSettingsPanel.js'

vi.mock('../../src/web/api.js')

describe('DeploymentSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getDeploymentSettings).mockResolvedValue({
      ok: true,
      data: { integrationToken: 'abc123', deploymentId: 'dep-1' },
    })
  })

  it('reveals the integration token on click, masked by default', async () => {
    const user = userEvent.setup()
    render(<DeploymentSettingsPanel onClose={vi.fn()} onLogout={vi.fn()} loggingOut={false} />)

    expect(screen.queryByText('abc123')).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: /show token/i }))
    expect(screen.getByText('abc123')).toBeInTheDocument()
  })

  it('calls onLogout when Log out is clicked', async () => {
    const user = userEvent.setup()
    const onLogout = vi.fn()
    render(<DeploymentSettingsPanel onClose={vi.fn()} onLogout={onLogout} loggingOut={false} />)

    await user.click(screen.getByRole('button', { name: /log out/i }))
    expect(onLogout).toHaveBeenCalled()
  })

  it('calls onClose when Close is clicked', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<DeploymentSettingsPanel onClose={onClose} onLogout={vi.fn()} loggingOut={false} />)

    await user.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/deployment-settings-panel.test.tsx`
Expected: FAIL — module does not exist

- [ ] **Step 3: Write `DeploymentSettingsPanel.tsx`**

```tsx
import type { CSSProperties, ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { getDeploymentSettings } from '../api.js'

export type DeploymentSettingsPanelProps = {
  onClose: () => void
  onLogout: () => void
  loggingOut: boolean
}

const panel: CSSProperties = {
  backgroundColor: 'var(--surface)',
  color: 'var(--text)',
  fontFamily: 'var(--fontFamily)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
  padding: 'var(--tilePadding)',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
}

const header: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '12px',
}

const heading: CSSProperties = { fontSize: '16px', fontWeight: 600, margin: 0 }

const smallButton: CSSProperties = {
  padding: '6px 12px',
  fontSize: '13px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  backgroundColor: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

export function DeploymentSettingsPanel({
  onClose,
  onLogout,
  loggingOut,
}: DeploymentSettingsPanelProps): ReactElement {
  const [token, setToken] = useState<string>('')
  const [deploymentId, setDeploymentId] = useState<string>('')
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const result = await getDeploymentSettings()
    if (!result.ok) {
      setError('Failed to load deployment settings')
      return
    }
    setError(null)
    setToken(result.data.integrationToken)
    setDeploymentId(result.data.deploymentId)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section data-testid="deployment-settings-panel" aria-label="Settings" style={panel}>
      <div style={header}>
        <h2 style={heading}>Settings</h2>
        <button type="button" style={smallButton} onClick={onClose}>
          Close
        </button>
      </div>

      {error !== null && <p style={{ color: 'var(--danger)', fontSize: '13px' }}>{error}</p>}

      <div style={{ fontSize: '12px', color: 'var(--textMuted)' }}>
        <div style={{ marginBottom: '4px' }}>
          Integration token — used to set up the Home Assistant integration by hand. Add-on
          installations are discovered automatically.
        </div>
        {tokenRevealed ? (
          <code data-testid="integration-token" style={{ wordBreak: 'break-all', fontSize: '11px' }}>
            {token}
          </code>
        ) : (
          <button type="button" style={smallButton} onClick={() => setTokenRevealed(true)}>
            Show token
          </button>
        )}
        <div style={{ marginTop: '8px' }}>Deployment id: {deploymentId}</div>
      </div>

      <button
        type="button"
        style={smallButton}
        disabled={loggingOut}
        onClick={onLogout}
      >
        {loggingOut ? 'Logging out…' : 'Log out'}
      </button>
    </section>
  )
}
```

- [ ] **Step 4: Delete `SettingsPanel.tsx` and its test**

```bash
rm src/web/components/SettingsPanel.tsx
git status --short test/unit/*.test.tsx | grep -i settings-panel
rm -f test/unit/settings-panel.test.tsx
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/deployment-settings-panel.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A src/web/components/DeploymentSettingsPanel.tsx src/web/components/SettingsPanel.tsx test/unit/deployment-settings-panel.test.tsx
git commit -m "feat: add the deployment settings panel with integration token and admin logout"
```

Note: `Portal.tsx` still imports the now-deleted `SettingsPanel` at this point in the plan — that reference is fixed in Task 24. A red `pnpm typecheck` on `Portal.tsx` alone between this task and Task 24 is expected.

### Task 23: `Shell` — title accepts a dropdown, plus a new below-header slot

**Files:**
- Modify: `src/web/themes/types.ts` (the `ShellProps` type — read this file first; it was not dumped in full during research, only referenced as the source of the `ShellProps` contract all four `Shell.tsx` files implement)
- Modify: `src/web/themes/default/Shell.tsx` (full contents already known, reproduced below with the change), `src/web/themes/cards/Shell.tsx`, `src/web/themes/classic/Shell.tsx`, `src/web/themes/tiles/Shell.tsx` (read each in full before editing — apply the same structural change default's gets, in that theme's own markup/class style, not a copy-paste of default's JSX)
- Test: `test/unit/shell.test.tsx` if it exists (grep for it — read before assuming; if none exists, this task's verification happens via Task 24's `Portal.tsx` integration test instead)

**Interfaces:**
- Produces: `ShellProps.title: ReactNode` (was `string`) and a new optional `ShellProps.belowHeader?: ReactNode` — rendered between the header row and the device grid, outside the grid itself (so it never becomes a grid cell). Used by `Portal.tsx` (Task 24) to place `PortalSettingsAccordion` there. The gear icon itself is not a new `ShellProps` field — it is one more element inside the existing `headerActions` slot, added by `Portal.tsx`.

- [ ] **Step 1: Change `ShellProps`**

Read `src/web/themes/types.ts` in full. Change `title: string` to `title: ReactNode`, and add `belowHeader?: ReactNode` as a new optional field (add `import type { ReactNode } from 'react'` if not already imported).

- [ ] **Step 2: Update all four `Shell.tsx` files**

For `src/web/themes/default/Shell.tsx`, the change is: destructure `belowHeader` in the props, and render it between the header `<div>` and the grid `<div>`. Full new contents:

```tsx
import type { ReactElement } from 'react'
import type { ShellProps } from '../types.js'

export function Shell({
  children,
  onLogout,
  loggingOut,
  title,
  headerActions,
  belowHeader,
}: ShellProps): ReactElement {
  return (
    <div
      data-testid="guest-screen"
      className="min-h-screen bg-[var(--appBg)] p-[var(--tilePadding)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-[var(--text)]">{title}</h1>
        <div className="flex items-center gap-2">
          {headerActions}
          <button
            type="button"
            onClick={onLogout}
            disabled={loggingOut}
            className="px-4 py-2 text-sm font-medium text-[var(--text)] bg-[var(--surface)] border border-[var(--border)] rounded-[var(--tileRadius)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loggingOut ? 'Logging out...' : 'Log out'}
          </button>
        </div>
      </div>

      {belowHeader}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-[var(--tileGap)] max-w-7xl">
        {children}
      </div>
    </div>
  )
}
```

For `cards`, `classic`, and `tiles`' `Shell.tsx`: read each file's actual current structure first (they were not dumped during research — this plan only confirmed `default`'s exact markup), then apply the equivalent change in that file's own layout terms — destructure `belowHeader` from props and render `{belowHeader}` between that theme's header block and its grid block, following whatever container/class pattern that specific file already uses (do not assume it matches `default`'s Tailwind classes; each theme's `Shell.tsx` has its own styling approach per the existing per-theme component pattern this codebase already follows).

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean for these five files specifically (the broader typecheck run may still show unrelated red from tasks not yet done in this plan — that's fine; just confirm no *new* error appears on `types.ts` or any `Shell.tsx`)

- [ ] **Step 4: Commit**

```bash
git add src/web/themes/types.ts src/web/themes/default/Shell.tsx src/web/themes/cards/Shell.tsx src/web/themes/classic/Shell.tsx src/web/themes/tiles/Shell.tsx
git commit -m "feat: let Shell take a dropdown title and a below-header slot for per-portal settings"
```

### Task 24: `Portal.tsx` — wire the dropdown, accordion, add-portal overlay, and gear panel

**Files:**
- Modify: `src/web/routes/Portal.tsx` (full current contents 595 lines)
- Test: `test/unit/portal-page.test.tsx` (existing — update it substantially)

**Interfaces:**
- Consumes: `PortalDropdown` (Task 20), `PortalSettingsAccordion` (Task 21), `DeploymentSettingsPanel` (Task 22), `CreatePortalScreen` (Task 19), `connectDeviceStore(portalId)` (Task 18), `useAllowlistEditor(devices, portalId)` (Task 17), `getPortalAllowlist` (Task 16, replacing `getAllowlist`).
- Produces: `PortalProps` gains a required `portalId: string`, a guest-only `guestPortalTitle?: string` (their own portal's title, from `SessionResponse` — a guest has no `portals` list to look a title up in), and admin-only optional fields: `portals?: PortalSummary[]`, `onSelectPortal?: (id: string) => void`, `onAddPortal?: () => void`, `addingPortal?: boolean`, `onPortalCreated?: (portal: PortalDetail) => void`, `onCancelAddPortal?: () => void`, `onPortalUpdated?: (portal: PortalDetail) => void`, `onPortalDeleted?: () => void`. `Mode` drops `'settings'` (now `'normal' | 'edit'`); the per-portal accordion is always visible (not a mode) and the deployment gear panel is a separate boolean overlay state local to this component.

- [ ] **Step 1: Write the failing test**

Read `test/unit/portal-page.test.tsx` in full first — it is 595+ lines with an extensive `CATALOG`/`seed()` fixture pattern established across this session's earlier work (recall the `icon: null` fixture fix from the MDI-icon task). Every `renderPortal('admin'|'guest')` helper call needs a `portalId` now; update its signature to `renderPortal(role, portalId = 'portal-1')` and pass it through to `<Portal role={role} portalId={portalId} onLogout={...} />`. Add:

```tsx
it('shows the portal dropdown for an admin with multiple portals', async () => {
  seed()
  render(
    <Portal
      role="admin"
      portalId="p1"
      onLogout={async () => {}}
      portals={[
        { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true },
        { id: 'p2', title: 'Mary', theme: 'tiles', enabled: true },
      ]}
      onSelectPortal={vi.fn()}
      onAddPortal={vi.fn()}
    />,
  )

  expect(screen.getByRole('combobox', { name: /portal/i })).toHaveValue('p1')
})

it('a guest sees their portal title as plain text, no dropdown', () => {
  seed()
  render(<Portal role="guest" portalId="p1" guestPortalTitle="Timothy" onLogout={async () => {}} />)
  expect(screen.getByRole('heading')).toHaveTextContent('Timothy')
  expect(screen.queryByRole('combobox', { name: /portal/i })).not.toBeInTheDocument()
})

it('the gear icon opens the deployment settings panel', async () => {
  const user = userEvent.setup()
  seed()
  render(<Portal role="admin" portalId="p1" onLogout={async () => {}} />)

  await user.click(screen.getByRole('button', { name: /^settings$/i }))
  expect(await screen.findByTestId('deployment-settings-panel')).toBeInTheDocument()
})

it('the per-portal settings accordion is always present for an admin, not a mode', () => {
  seed()
  render(<Portal role="admin" portalId="p1" onLogout={async () => {}} />)
  expect(screen.getByRole('button', { name: /portal settings/i })).toBeInTheDocument()
})

it('a guest sees no per-portal settings accordion', () => {
  seed()
  render(<Portal role="guest" portalId="p1" onLogout={async () => {}} />)
  expect(screen.queryByRole('button', { name: /portal settings/i })).not.toBeInTheDocument()
})
```

Also update every existing test in the file that referenced `mode === 'settings'` behavior (search for `settings-overlay`, `Settings` button text expecting the old overlay, or `SettingsPanel`) to match the new split: clicking the (now icon-only) gear button opens `deployment-settings-panel`, and the per-portal fields live in the always-rendered accordion instead of behind a mode toggle. Update any test asserting `getAllowlist` was called to assert `getPortalAllowlist` was called with the portal id instead (mirroring the `api.js` rename from Task 16).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/portal-page.test.tsx`
Expected: FAIL — extensively, until Step 3 lands

- [ ] **Step 3: Rewrite `Portal.tsx`**

The style constants (`headerButton` through `modeBanner`, lines 27–184 of the original) are unchanged — copy them through verbatim. `DeviceTile` and `EditableTile` (lines 191–276) are unchanged — copy them through verbatim too. What changes is the `Portal` component itself:

```tsx
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { CatalogEntry, Device, Role } from '@shared/api.js'
import type { z } from 'zod'
import type { PortalDetailResponse } from '@shared/api.js'
import { getPortalAllowlist, getCatalog } from '../api.js'
import { CreatePortalScreen } from '../components/CreatePortalScreen.js'
import { DeploymentSettingsPanel } from '../components/DeploymentSettingsPanel.js'
import { EntityPicker } from '../components/EntityPicker.js'
import { PortalDropdown, type PortalSummary } from '../components/PortalDropdown.js'
import { PortalSettingsAccordion } from '../components/PortalSettingsAccordion.js'
import { TileEditor } from '../components/TileEditor.js'
import { useAllowlistEditor } from '../hooks/useAllowlistEditor.js'
import { connectDeviceStore, useDeviceStore } from '../store.js'
import { activeTheme, componentsFor } from '../themes/active.js'
import type { DEFAULT_COMPONENTS } from '../themes/default/index.js'

type PortalDetail = z.infer<typeof PortalDetailResponse>

type PortalProps = {
  role: Role
  portalId: string
  onLogout: () => Promise<void>
  /** Guest-only: their own portal's title, straight from their SessionResponse
   * (Task 8) — a guest is never given `portals`, so the title can't be looked
   * up the way the admin path looks it up. */
  guestPortalTitle?: string
  portals?: PortalSummary[]
  onSelectPortal?: (id: string) => void
  onAddPortal?: () => void
  addingPortal?: boolean
  onPortalCreated?: (portal: PortalDetail) => void
  onCancelAddPortal?: () => void
  onPortalUpdated?: (portal: PortalDetail) => void
  onPortalDeleted?: () => void
}

type Components = typeof DEFAULT_COMPONENTS

/** Edit is the only mode left — Settings is no longer mutually exclusive with
 * it, since the per-portal accordion is always visible and the deployment
 * panel is a plain boolean overlay. */
type Mode = 'normal' | 'edit'

// ... [headerButton through modeBanner style constants: copy verbatim from
//      the current file, lines 27-184] ...

// ... [DeviceTile, lines 191-219: copy verbatim] ...

// ... [EditableTile, lines 232-276: copy verbatim] ...

export function Portal({
  role,
  portalId,
  onLogout,
  portals,
  onSelectPortal,
  onAddPortal,
  addingPortal,
  onPortalCreated,
  onCancelAddPortal,
  onPortalUpdated,
  onPortalDeleted,
}: PortalProps): ReactElement {
  const [loggingOut, setLoggingOut] = useState(false)
  const [mode, setMode] = useState<Mode>('normal')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [showDeploymentSettings, setShowDeploymentSettings] = useState(false)
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [orphaned, setOrphaned] = useState<string[]>([])
  const [orphanCheckFailed, setOrphanCheckFailed] = useState(false)

  // Connect to the device store for the current portal on mount, and
  // reconnect whenever the admin switches to a different portal.
  useEffect(() => {
    const teardown = connectDeviceStore(portalId)
    return teardown
  }, [portalId])

  const { devices, connected } = useDeviceStore()
  const editor = useAllowlistEditor(devices, portalId)
  const isOwner = role === 'admin'

  const components = componentsFor(activeTheme())
  const { Shell } = components

  const loadOrphaned = useCallback(async (): Promise<void> => {
    setOrphanCheckFailed(false)
    try {
      const result = await getPortalAllowlist(portalId)
      if (!result.ok) {
        setOrphanCheckFailed(true)
        return
      }
      setOrphaned(result.data.orphaned)
    } catch {
      setOrphanCheckFailed(true)
    }
  }, [portalId])

  const loadCatalog = useCallback(async (): Promise<void> => {
    setCatalogFailed(false)
    try {
      const result = await getCatalog()
      if (!result.ok) {
        setCatalogFailed(true)
        return
      }
      setCatalog(result.data)
    } catch {
      setCatalogFailed(true)
    }
  }, [])

  useEffect(() => {
    if (mode !== 'edit') return
    void loadOrphaned()
  }, [mode, loadOrphaned])

  function show(next: Mode): void {
    setMode(next)
    setEditingId(null)
    setAdding(false)
  }

  const editingRow =
    editingId === null ? undefined : editor.rows.find((row) => row.entityId === editingId)

  const sortedDevices = [...devices].sort((a, b) => a.sortOrder - b.sortOrder)
  const tilesDisabled = !connected

  async function handleLogout(): Promise<void> {
    setLoggingOut(true)
    await onLogout()
  }

  function pickerBody(): ReactElement {
    if (catalogFailed) {
      return (
        <>
          <p style={errorText}>Could not load the device list</p>
          <div>
            <button type="button" style={smallButton} onClick={() => void loadCatalog()}>
              Retry
            </button>
          </div>
        </>
      )
    }

    if (catalog === null) {
      return <p style={mutedText}>Loading devices…</p>
    }

    return (
      <EntityPicker
        entities={catalog}
        exclude={editor.rows.map((row) => row.entityId)}
        onSelect={(entity) => {
          editor.add(entity)
          setAdding(false)
        }}
      />
    )
  }

  const children: ReactElement[] =
    sortedDevices.length === 0
      ? [
          <p key="__empty" className="text-[var(--textMuted)]">
            No devices available
          </p>,
        ]
      : sortedDevices.map((device) =>
          mode === 'edit' ? (
            <EditableTile
              key={device.entityId}
              device={device}
              components={components}
              orphaned={orphaned.includes(device.entityId)}
              onEdit={setEditingId}
            />
          ) : (
            <DeviceTile
              key={device.entityId}
              device={device}
              disabled={tilesDisabled}
              components={components}
            />
          ),
        )

  if (mode === 'edit') {
    if (orphanCheckFailed) {
      children.push(
        <div key="__orphan-error" style={panel}>
          <p style={errorText}>
            Could not check for orphaned devices — Home Assistant may be unreachable.
          </p>
          <div>
            <button type="button" style={smallButton} onClick={() => void loadOrphaned()}>
              Retry
            </button>
          </div>
        </div>,
      )
    }

    children.push(
      <div key="__ghost">
        <button
          type="button"
          style={ghostButton}
          onClick={() => {
            setAdding(true)
            void loadCatalog()
          }}
        >
          + Add device
        </button>
      </div>,
    )

    children.push(
      <div key="__mode-banner" role="status" style={modeBanner}>
        Edit mode — tap a device to change it. Changes save as you make them.
      </div>,
    )
  }

  if (adding) {
    children.push(
      <div key="__overlay" data-testid="picker-overlay" style={overlayBackdrop}>
        <div style={pickerInner}>
          <section style={{ ...panel, flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
            <div style={panelHeader}>
              <h2 style={panelHeading}>Add a device</h2>
              <button type="button" style={smallButton} onClick={() => setAdding(false)}>
                Close
              </button>
            </div>
            {pickerBody()}
          </section>
        </div>
      </div>,
    )
  } else if (showDeploymentSettings) {
    children.push(
      <div key="__overlay" data-testid="settings-overlay" style={overlayBackdrop}>
        <div style={settingsInner}>
          <DeploymentSettingsPanel
            onClose={() => setShowDeploymentSettings(false)}
            onLogout={() => {
              void handleLogout()
            }}
            loggingOut={loggingOut}
          />
        </div>
      </div>,
    )
  } else if (addingPortal === true) {
    children.push(
      <div key="__overlay" data-testid="add-portal-overlay" style={overlayBackdrop}>
        <div style={overlayInner}>
          <CreatePortalScreen
            onCreated={(portal) => {
              onPortalCreated?.(portal)
              onCancelAddPortal?.()
            }}
          />
        </div>
      </div>,
    )
  } else if (editingRow !== undefined) {
    children.push(
      <div key="__overlay" data-testid="editor-overlay" style={overlayBackdrop}>
        <div style={overlayInner}>
          <TileEditor
            key={editingRow.entityId}
            row={editingRow}
            editor={editor}
            onClose={() => setEditingId(null)}
          />
        </div>
      </div>,
    )
  }

  const ownerActions = isOwner
    ? {
        headerActions: (
          <>
            <button
              type="button"
              style={mode === 'edit' ? headerButtonOn : headerButton}
              onClick={() => show(mode === 'edit' ? 'normal' : 'edit')}
            >
              {mode === 'edit' ? 'Done' : 'Edit'}
            </button>
            <button
              type="button"
              aria-label="Settings"
              style={headerButton}
              onClick={() => setShowDeploymentSettings(true)}
            >
              ⚙
            </button>
          </>
        ),
      }
    : {}

  const titleNode: ReactElement | string =
    isOwner && portals !== undefined && onSelectPortal !== undefined && onAddPortal !== undefined ? (
      <PortalDropdown
        portals={portals}
        selectedId={portalId}
        onSelect={onSelectPortal}
        onAddPortal={onAddPortal}
      />
    ) : (
      // Guest header keeps a plain title. There is no `portals` list to look
      // it up in — App.tsx already has it on the guest's own SessionResponse
      // and threads it straight through as `guestPortalTitle`.
      (guestPortalTitle ?? '')
    )

  const belowHeader = isOwner ? (
    <PortalSettingsAccordion
      portalId={portalId}
      onUpdated={(portal) => onPortalUpdated?.(portal)}
      onDeleted={() => onPortalDeleted?.()}
    />
  ) : undefined

  return (
    <Shell
      title={titleNode}
      loggingOut={loggingOut}
      onLogout={() => {
        void handleLogout()
      }}
      belowHeader={belowHeader}
      {...ownerActions}
    >
      {children}
    </Shell>
  )
}
```

Strengthen Step 1's second test case ("a guest sees their portal title as plain text, no dropdown") to pass `guestPortalTitle="Timothy"` and assert `expect(screen.getByRole('heading')).toHaveTextContent('Timothy')`, not just the dropdown's absence — the point of that test is that the *correct* title renders, not merely that the wrong control doesn't.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/portal-page.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/Portal.tsx test/unit/portal-page.test.tsx
git commit -m "feat: wire the portal dropdown, accordion, add-portal overlay, and gear panel into Portal"
```

### Task 25: `App.tsx` — session discrimination, portal list, zero-portal gate

**Files:**
- Modify: `src/web/App.tsx` (full current contents 146 lines)
- Modify: `src/web/themes/default/Login.tsx` (and the other three themes' `Login.tsx`) — **read each in full before editing**; not dumped during research. Their `onSuccess` callback's parameter type must change from whatever it is today to `z.infer<typeof SessionResponse>` (the full discriminated union `login()` now resolves to, per Task 16), since `App.tsx` needs the whole session, not just a role, to seed portal state on login.
- Test: `test/unit/app.test.tsx` if it exists (grep for it — App-level behavior may currently be covered inside `test/unit/portal-page.test.tsx`'s broader fixtures instead; read whichever file actually exercises `<App />` directly)

**Interfaces:**
- Consumes: `getPortals`, `putLastSelectedPortal`, `createPortal` outcome (Task 16), `SessionResponse`'s discriminated union (Task 8), `Portal`'s expanded props (Task 24).
- Produces: no new exports — this is the top of the tree.

- [ ] **Step 1: Write the failing test**

If no existing App-level test file is found, create `test/unit/app.test.tsx` following the mocking conventions already established in `test/unit/portal-page.test.tsx` (same `vi.mock('../../src/web/api.js')` pattern):

```tsx
// test/unit/app.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import * as api from '../../src/web/api.js'
import * as store from '../../src/web/store.js'
import { App } from '../../src/web/App.js'

vi.mock('../../src/web/api.js')

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(store, 'connectDeviceStore').mockReturnValue(() => {})
  })

  it('shows the create-portal screen full-page when an admin has zero portals', async () => {
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: { portals: [], lastSelectedPortalId: null },
    })

    render(<App />)

    expect(await screen.findByText(/create a portal/i)).toBeInTheDocument()
  })

  it('selects the last-selected portal for an admin with existing portals', async () => {
    vi.mocked(api.getSession).mockResolvedValue({ role: 'admin' })
    vi.mocked(api.getPortals).mockResolvedValue({
      ok: true,
      data: {
        portals: [
          { id: 'p1', title: 'Timothy', theme: 'classic', enabled: true },
          { id: 'p2', title: 'Mary', theme: 'tiles', enabled: true },
        ],
        lastSelectedPortalId: 'p2',
      },
    })
    vi.mocked(api.getCatalog).mockResolvedValue({ ok: true, data: [] })
    vi.mocked(api.getPortalAllowlist).mockResolvedValue({ ok: true, data: { devices: [], orphaned: [] } })

    render(<App />)

    await waitFor(() => expect(screen.getByRole('combobox', { name: /portal/i })).toHaveValue('p2'))
  })

  it('renders a guest\'s own portal with no dropdown', async () => {
    vi.mocked(api.getSession).mockResolvedValue({
      role: 'guest',
      portalId: 'p1',
      portalTitle: "Timothy's Portal",
      portalTheme: 'classic',
      portalEnabled: true,
    })

    render(<App />)

    expect(await screen.findByRole('heading', { name: "Timothy's Portal" })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /portal/i })).not.toBeInTheDocument()
  })

  it('shows the disabled screen when the guest\'s own portal is off', async () => {
    vi.mocked(api.getSession).mockResolvedValue({
      role: 'guest',
      portalId: 'p1',
      portalTitle: 'Timothy',
      portalTheme: 'classic',
      portalEnabled: false,
    })

    render(<App />)

    expect(await screen.findByTestId('disabled-screen')).toBeInTheDocument() // adapt to whatever
    // test id / role the existing Disabled component actually exposes — check
    // src/web/themes/default/Disabled.tsx and the existing App-level disabled
    // test coverage (however it asserts this today) before writing this line
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/app.test.tsx`
Expected: FAIL — `getPortals` isn't called anywhere yet, `role === 'admin'`'s session shape has no portal-list handling

- [ ] **Step 3: Rewrite `App.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { z } from 'zod'
import type { PortalDetailResponse, SessionResponse } from '@shared/api.js'
import { getPortals, getSession, logout, putLastSelectedPortal, setUnauthorizedCallback } from './api.js'
import { Portal } from './routes/Portal.js'
import { setPortalEnabled, useDeviceStore } from './store.js'
import { activeTheme, componentsFor } from './themes/active.js'
import type { PortalSummary } from './components/PortalDropdown.js'

type PortalDetail = z.infer<typeof PortalDetailResponse>
type Session = z.infer<typeof SessionResponse>

type AppState =
  | { kind: 'loading' }
  | { kind: 'unreachable' }
  | { kind: 'logged-out' }
  | { kind: 'guest'; session: Extract<Session, { role: 'guest' }> }
  | {
      kind: 'admin'
      portals: PortalSummary[]
      selectedPortalId: string | null
      addingPortal: boolean
    }

export function App(): ReactElement {
  const { Login, Disabled, Unreachable } = componentsFor(activeTheme())
  const [state, setState] = useState<AppState>({ kind: 'loading' })
  const { connected, portalEnabled } = useDeviceStore()
  const prevConnectedRef = useRef<boolean>(false)

  useEffect(() => {
    setUnauthorizedCallback(() => {
      setState({ kind: 'logged-out' })
    })
    return () => {
      setUnauthorizedCallback(null)
    }
  }, [])

  const loadAdminPortals = useCallback(async (): Promise<void> => {
    const result = await getPortals()
    if (!result.ok) {
      setState({ kind: 'unreachable' })
      return
    }

    const { portals, lastSelectedPortalId } = result.data
    const selected =
      lastSelectedPortalId !== null && portals.some((p) => p.id === lastSelectedPortalId)
        ? lastSelectedPortalId
        : (portals[0]?.id ?? null)

    setState({ kind: 'admin', portals, selectedPortalId: selected, addingPortal: false })
  }, [])

  const applySession = useCallback(
    (session: Session): void => {
      if (session.role === 'admin') {
        void loadAdminPortals()
        return
      }

      setPortalEnabled(session.portalEnabled)
      setState({ kind: 'guest', session })
    },
    [loadAdminPortals],
  )

  const checkSession = useCallback(async (): Promise<void> => {
    try {
      const session = await getSession()
      if (session === null) {
        setState({ kind: 'logged-out' })
        return
      }
      applySession(session)
    } catch {
      setState({ kind: 'unreachable' })
    }
  }, [applySession])

  useEffect(() => {
    void checkSession()
  }, [checkSession])

  useEffect(() => {
    const wasConnected = prevConnectedRef.current
    prevConnectedRef.current = connected

    if (wasConnected || connected || state.kind !== 'guest') return
    // (unreachable in practice given the condition above always short-circuits
    // on `wasConnected && !connected` — preserved from the original file's
    // transition-only recheck; see the recheckPortal effect below for the
    // guest polling loop this really relies on.)
  }, [connected, state.kind])

  const recheckPortal = useCallback(async (): Promise<void> => {
    try {
      const session = await getSession()
      if (session === null) {
        setState({ kind: 'logged-out' })
        return
      }
      if (session.role === 'guest') {
        setPortalEnabled(session.portalEnabled)
        setState({ kind: 'guest', session })
      }
    } catch {
      // Swallow: same reasoning as before — a failed poll should leave the
      // disabled screen alone and let the next tick try again.
    }
  }, [])

  useEffect(() => {
    if (state.kind !== 'guest' || state.session.portalEnabled) return

    const timer = setInterval(() => {
      void recheckPortal()
    }, 15_000)

    return () => clearInterval(timer)
  }, [state, recheckPortal])

  async function handleLoginSuccess(session: Session): Promise<void> {
    applySession(session)
  }

  async function handleLogout(): Promise<void> {
    await logout()
    setState({ kind: 'logged-out' })
  }

  function handleSelectPortal(portalId: string): void {
    if (state.kind !== 'admin') return
    setState({ ...state, selectedPortalId: portalId })
    void putLastSelectedPortal(portalId)
  }

  function handlePortalCreated(portal: PortalDetail): void {
    if (state.kind !== 'admin') return
    const nextPortals = [...state.portals, portal]
    setState({ ...state, portals: nextPortals, selectedPortalId: portal.id, addingPortal: false })
    void putLastSelectedPortal(portal.id)
  }

  function handlePortalUpdated(portal: PortalDetail): void {
    if (state.kind !== 'admin') return
    setState({
      ...state,
      portals: state.portals.map((p) => (p.id === portal.id ? portal : p)),
    })
  }

  function handlePortalDeleted(): void {
    if (state.kind !== 'admin') return
    void loadAdminPortals()
  }

  if (state.kind === 'loading') {
    return <div>Loading...</div>
  }

  if (state.kind === 'unreachable') {
    return (
      <Unreachable
        onRetry={() => {
          setState({ kind: 'loading' })
          void checkSession()
        }}
      />
    )
  }

  if (state.kind === 'logged-out') {
    return <Login onSuccess={(session: Session) => void handleLoginSuccess(session)} />
  }

  if (state.kind === 'guest') {
    if (!state.session.portalEnabled) {
      return (
        <Disabled
          onRetry={() => {
            void recheckPortal()
          }}
        />
      )
    }

    return (
      <Portal
        role="guest"
        portalId={state.session.portalId}
        guestPortalTitle={state.session.portalTitle}
        onLogout={handleLogout}
      />
    )
  }

  // state.kind === 'admin'
  if (state.portals.length === 0 && !state.addingPortal) {
    return <CreatePortalScreenFullPage onCreated={handlePortalCreated} />
  }

  if (state.selectedPortalId === null) {
    // Should be unreachable once `portals.length > 0` (loadAdminPortals always
    // picks a selection when the list is non-empty), but the type is nullable
    // — fail toward the create screen rather than rendering Portal with an
    // impossible empty portalId.
    return <CreatePortalScreenFullPage onCreated={handlePortalCreated} />
  }

  return (
    <Portal
      role="admin"
      portalId={state.selectedPortalId}
      onLogout={handleLogout}
      portals={state.portals}
      onSelectPortal={handleSelectPortal}
      onAddPortal={() => setState({ ...state, addingPortal: true })}
      addingPortal={state.addingPortal}
      onPortalCreated={handlePortalCreated}
      onCancelAddPortal={() => setState({ ...state, addingPortal: false })}
      onPortalUpdated={handlePortalUpdated}
      onPortalDeleted={handlePortalDeleted}
    />
  )
}
```

`CreatePortalScreenFullPage` above is a two-line wrapper, not a new component file — add it directly in `App.tsx` above the `App` function:

```tsx
function CreatePortalScreenFullPage({ onCreated }: { onCreated: (portal: PortalDetail) => void }): ReactElement {
  return <CreatePortalScreen onCreated={onCreated} />
}
```

(It exists only so the two call sites above read as intent — "the full-page case" — even though today it does nothing `<CreatePortalScreen>` doesn't already do on its own. Do not add layout wrapping here unless `CreatePortalScreen`'s own styling, Task 19, does not already center/pad itself as a standalone page — it does, per Task 19's `wrap` style with `margin: '64px auto'` — so this wrapper can also just be deleted and the two call sites can use `<CreatePortalScreen onCreated={handlePortalCreated} />` directly. Prefer deleting it; it was named here only to make the diff above easier to read one call site at a time.)

Note the awkward leftover effect (`if (wasConnected || connected || state.kind !== 'guest') return`) preserved with a comment explaining it is dead relative to the original file's intent — **do not actually ship that effect as dead code**. The original file's stream-disconnect recheck (`useEffect` at lines 51-75 of the source) served a real purpose: catching a guest's stream dropping and re-verifying their session. Rewrite it properly instead of leaving the stub above:

```tsx
useEffect(() => {
  const wasConnected = prevConnectedRef.current
  prevConnectedRef.current = connected

  if (!wasConnected || connected || state.kind !== 'guest') return

  async function recheckSession(): Promise<void> {
    try {
      const session = await getSession()
      if (session === null) {
        setState({ kind: 'logged-out' })
        return
      }
      if (session.role === 'guest') {
        setPortalEnabled(session.portalEnabled)
        setState({ kind: 'guest', session })
      }
    } catch {
      // Deliberately swallowed — see the original file's comment at this same
      // spot: the stream reconnects on its own, and this poll should not put
      // up a Retry screen for a five-second blip.
    }
  }

  void recheckSession()
}, [connected, state])
```

Replace the earlier stub effect with this one — there should be exactly one `useEffect` handling the connect→disconnect transition in the final file, not two.

- [ ] **Step 4: Update the four `Login.tsx` components**

Read each theme's `Login.tsx` in full. Update its `onSuccess` prop type to `(session: z.infer<typeof SessionResponse>) => void` (or `Promise<void>`, matching whatever the current signature already returns), and update its call site (wherever it currently calls `login(password)` and passes `result.data.role` or similar to `onSuccess`) to pass `result.data` — the whole session object — instead of just extracting `.role`.

Each theme's `Login.tsx` has its own test file (grep for it, e.g. `test/unit/login-*.test.tsx` or similar per-theme naming — read whichever exists). Update every test that asserts what `onSuccess` was called with (likely currently asserting a bare role string) to assert the full session object instead, matching whatever fixture shape `SessionResponse` now requires (e.g. `{ role: 'admin' }` or `{ role: 'guest', portalId, portalTitle, portalTheme, portalEnabled }`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/app.test.tsx`
Expected: PASS

- [ ] **Step 6: Full web-side verification**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: clean across the entire repo — this is the task where every remaining red from Tasks 16–24's intentionally-deferred breakage should finally clear.

- [ ] **Step 7: Commit**

```bash
git add src/web/App.tsx src/web/themes/default/Login.tsx src/web/themes/cards/Login.tsx src/web/themes/classic/Login.tsx src/web/themes/tiles/Login.tsx test/unit/app.test.tsx
git commit -m "feat: give App a portal list, zero-portal gate, and per-session portal theming"
```

At this point the entire TypeScript side (server and web) should be green: `pnpm vitest run && pnpm typecheck && pnpm lint` clean, plus a manual smoke test is worthwhile before moving to the Python integration — run `pnpm build && pnpm test:e2e` and expect the existing e2e suite to fail in ways that trace directly to the multi-portal UI changes (the fixed test-admin-password/test-guest-password flow in `test/e2e/harness.ts` predates portals entirely). Fixing the e2e suite for multi-portal is intentionally **not** a task in this plan — it is significant, separable follow-up work (a new harness needs to create a portal via the API or wizard before any guest-flow test can log in at all) and belongs in its own plan once this one's unit/integration coverage is solid. Flag this explicitly to the project owner when this phase completes rather than silently leaving e2e red.

## Phase 7: Home Assistant custom integration

### Task 26: `routes-integration.ts` — list-shaped state, per-portal enable

**Files:**
- Modify: `src/server/http/routes-integration.ts` (full current contents 86 lines)
- Test: `test/integration/routes-integration.test.ts` (existing — update it)

**Interfaces:**
- Produces: `GET /api/integration/state` returns `IntegrationStateResponse` (Task 8's list-shaped version: `{ deploymentId, haStale, version, portals: [...] }`). `POST /api/integration/enabled` becomes `POST /api/integration/portals/:portalId/enabled` (path-scoped, since there is no longer one global enabled flag to toggle).
- Bump `INTEGRATION_API_VERSION` to `'2.0.0'` (a breaking response-shape change, per this file's own doc comment on that constant: "Bump when the shape of `/api/integration/state` changes").

- [ ] **Step 1: Write the failing test**

Read `test/integration/routes-integration.test.ts` in full first, then replace its `/api/integration/state` and `/api/integration/enabled` tests with:

```ts
it('reports every portal in the deployment', async () => {
  const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass' })
  allowlist.replace(timothy.id, [
    { entityId: 'light.a', label: 'A', allowedActions: ['turn_on'], sortOrder: 0 },
  ])

  const res = await fetch(`${baseUrl}/api/integration/state`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = await res.json()

  expect(body.portals).toHaveLength(1)
  expect(body.portals[0]).toMatchObject({
    portalId: timothy.id,
    title: 'Timothy',
    enabled: true,
    deviceCount: 1,
  })
  expect(typeof body.deploymentId).toBe('string')
  expect(body.version).toBe('2.0.0')
})

it('enables and disables a specific portal by id', async () => {
  const timothy = portals.create({ title: 'Timothy', password: 'timothy-pass-2' })

  const res = await fetch(`${baseUrl}/api/integration/portals/${timothy.id}/enabled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ enabled: false }),
  })

  expect(res.status).toBe(200)
  expect(portals.get(timothy.id)?.enabled).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/integration/routes-integration.test.ts`
Expected: FAIL — current `/api/integration/state` returns a single-portal shape, `/api/integration/enabled` has no portal id

- [ ] **Step 3: Rewrite `routes-integration.ts`**

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
export const INTEGRATION_API_VERSION = '2.0.0'

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
 * opens exactly these routes — it cannot read or write the allowlist, read
 * the audit log, or log in. It is served on the LAN-facing port because the
 * plain Docker deployment has no Supervisor network available.
 */
export function mountIntegrationRoutes(app: Hono<Env>, deps: Deps): void {
  const { allowlist, ha, settings, interactions, portals } = deps

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
        deploymentId: settings.getDeploymentId(),
        haStale: ha.stale,
        version: INTEGRATION_API_VERSION,
        portals: portals.list().map((portal) => ({
          portalId: portal.id,
          title: portal.title,
          enabled: portal.enabled,
          deviceCount: allowlist.list(portal.id).length,
          lastInteraction: interactions.latest(portal.id),
        })),
      }),
    )
  })

  app.post('/api/integration/portals/:portalId/enabled', async (c) => {
    const portalId = c.req.param('portalId')
    if (portals.get(portalId) === null) {
      return c.json({ error: 'Not found' }, 404)
    }

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

    portals.update(portalId, { enabled: parseResult.data.enabled })

    return c.json({ enabled: parseResult.data.enabled })
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/integration/routes-integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/http/routes-integration.ts test/integration/routes-integration.test.ts
git commit -m "feat: report every portal to the HA integration, enable/disable by portal id"
```

### Task 27: `api.py` — parse the list-shaped state, enable/disable by portal id

**Files:**
- Modify: `custom_components/ha_guest_portal/api.py` (full current contents 129 lines)
- Modify: `custom_components/ha_guest_portal/const.py` (full current contents 16 lines — bump `MIN_PORTAL_VERSION`)
- Modify: `custom_components/ha_guest_portal/config_flow.py` (full current contents 153 lines — update the one call site that reads `state.portal_id`)
- Test: `tests/test_api.py` (existing — update it)

**Interfaces:**
- Produces: `PortalSummary` dataclass (`portal_id`, `title`, `enabled`, `device_count`, `last_interaction`) replacing the old single-portal `PortalState`. `DeploymentState` dataclass (`deployment_id`, `ha_stale`, `version`, `portals: list[PortalSummary]`) replacing the old `PortalState` as `async_get_state()`'s return type. `PortalApi.async_set_enabled(portal_id: str, enabled: bool) -> None` (gains a leading `portal_id` parameter; posts to `/api/integration/portals/{portal_id}/enabled`).

- [ ] **Step 1: Write the failing test**

Read `tests/test_api.py` in full first to match its existing `aioresponses`/fixture style, then replace the `async_get_state`/`async_set_enabled` tests with:

```python
async def test_async_get_state_parses_a_list_of_portals(portal_api, mock_aioresponse):
    mock_aioresponse.get(
        f"{portal_api.base_url}/api/integration/state",
        payload={
            "deploymentId": "dep-1",
            "haStale": False,
            "version": "2.0.0",
            "portals": [
                {
                    "portalId": "p1",
                    "title": "Timothy",
                    "enabled": True,
                    "deviceCount": 3,
                    "lastInteraction": None,
                },
            ],
        },
    )

    state = await portal_api.async_get_state()

    assert state.deployment_id == "dep-1"
    assert len(state.portals) == 1
    assert state.portals[0].portal_id == "p1"
    assert state.portals[0].title == "Timothy"
    assert state.portals[0].device_count == 3


async def test_async_set_enabled_posts_to_the_portal_specific_route(portal_api, mock_aioresponse):
    mock_aioresponse.post(f"{portal_api.base_url}/api/integration/portals/p1/enabled", payload={"enabled": False})

    await portal_api.async_set_enabled("p1", False)

    request = mock_aioresponse.requests[("POST", f"{portal_api.base_url}/api/integration/portals/p1/enabled")][0]
    assert request.kwargs["json"] == {"enabled": False}
```

(Adapt fixture names `portal_api`/`mock_aioresponse` to whatever `tests/conftest.py` actually defines — read it first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_api.py`
Expected: FAIL — `PortalState`/`async_get_state` still parse a single-portal shape; `async_set_enabled` takes one argument

- [ ] **Step 3: Rewrite `api.py`**

```python
"""HTTP client for the Guest Portal add-on's integration API."""

from __future__ import annotations

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
class PortalSummary:
    """One portal's state, as reported inside /api/integration/state's list."""

    portal_id: str
    title: str
    enabled: bool
    device_count: int
    last_interaction: Interaction | None


@dataclass(frozen=True)
class DeploymentState:
    """A snapshot of the whole deployment, as returned by /api/integration/state."""

    deployment_id: str
    ha_stale: bool
    version: str
    portals: list[PortalSummary]


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


def _parse_portal_summary(raw: Any) -> PortalSummary:
    return PortalSummary(
        portal_id=str(raw["portalId"]),
        title=str(raw["title"]),
        enabled=bool(raw["enabled"]),
        device_count=int(raw["deviceCount"]),
        last_interaction=_parse_interaction(raw["lastInteraction"]),
    )


def _parse_deployment_state(raw: Any) -> DeploymentState:
    # Missing or invalid version is treated as 0.0.0, which will fail the
    # minimum-version check and raise a repair issue rather than retrying forever.
    version = raw.get("version", "0.0.0")
    if not isinstance(version, str):
        version = "0.0.0"

    return DeploymentState(
        deployment_id=str(raw["deploymentId"]),
        ha_stale=bool(raw["haStale"]),
        version=version,
        portals=[_parse_portal_summary(p) for p in raw["portals"]],
    )


class PortalApi:
    """Talks to the bearer-authenticated routes the portal exposes."""

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
        except (TimeoutError, aiohttp.ClientError, ValueError) as err:
            raise PortalConnectionError(f"Could not reach the portal: {err}") from err

    async def async_get_state(self) -> DeploymentState:
        """Fetch every portal's current state."""
        raw = await self._request("GET", "/api/integration/state")

        try:
            return _parse_deployment_state(raw)
        except (KeyError, TypeError, ValueError) as err:
            # An add-on too old to speak this protocol looks exactly like this.
            raise PortalConnectionError(f"Unexpected response from the portal: {err}") from err

    async def async_set_enabled(self, portal_id: str, enabled: bool) -> None:
        """Enable or disable one portal."""
        await self._request(
            "POST", f"/api/integration/portals/{portal_id}/enabled", json={"enabled": enabled}
        )
```

In `const.py`, change `MIN_PORTAL_VERSION = "1.0.0"` to `MIN_PORTAL_VERSION = "2.0.0"` — the response shape this integration can parse changed in a way old add-ons cannot satisfy, so the repair-issue floor must move with it.

In `config_flow.py`, `_async_probe` currently does `return state.portal_id`. Change it to `return state.deployment_id` (the field this dataclass exposes now), and rename the local variable `portal_id` to `deployment_id` throughout `_async_probe`, `async_step_user`, and `async_step_reauth_confirm` for clarity (it was always the *deployment's* identity being probed for uniqueness, never an individual portal's — the old name just predates portals existing as a concept). This is a pure rename with no behavior change; `async_step_hassio`'s own `config.get("portalId")` (the Supervisor discovery payload key) is untouched — that key name is Supervisor-side config unrelated to this file's internal variable naming, and renaming it would require a `config.yaml` discovery schema change this plan explicitly does not make.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_api.py tests/test_config_flow.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add custom_components/ha_guest_portal/api.py custom_components/ha_guest_portal/const.py custom_components/ha_guest_portal/config_flow.py tests/test_api.py
git commit -m "feat: parse the per-deployment list of portals, enable/disable by portal id"
```

### Task 28: `entity.py` — one device per portal, keyed by deployment + portal id

**Files:**
- Modify: `custom_components/ha_guest_portal/entity.py` (full current contents 36 lines)
- Test: new `tests/test_entity.py` (no dedicated file exists today — this class was only exercised indirectly via `tests/test_switch.py`/`tests/test_sensor.py`)

**Interfaces:**
- Produces: `GuestPortalEntity.__init__(self, coordinator: GuestPortalCoordinator, portal_id: str, key: str)` (gains `portal_id`). `unique_id` becomes `f"{deployment_id}_{portal_id}_{key}"`; `device_info.identifiers` becomes `{(DOMAIN, f"{deployment_id}_{portal_id}")}` — each portal groups under its own HA device instead of every entity sharing one. New method `_current_portal(self) -> PortalSummary | None` — looks up this entity's own portal in `coordinator.data.portals` by id, returning `None` if it has been removed since the last poll (a delete-mid-refresh race; callers must handle this rather than assume the portal always exists).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_entity.py
# Follow whatever fixture pattern tests/test_switch.py already uses to build a
# fake coordinator with DeploymentState/PortalSummary data — read it first.

def test_unique_id_and_device_combine_deployment_and_portal_id(coordinator_with_two_portals):
    entity = GuestPortalEntity(coordinator_with_two_portals, "portal-a", "switch")

    assert entity.unique_id == "dep-1_portal-a_switch"
    assert entity.device_info["identifiers"] == {(DOMAIN, "dep-1_portal-a")}


def test_current_portal_finds_its_own_portal(coordinator_with_two_portals):
    entity = GuestPortalEntity(coordinator_with_two_portals, "portal-a", "switch")
    portal = entity._current_portal()
    assert portal is not None
    assert portal.portal_id == "portal-a"


def test_current_portal_returns_none_when_removed(coordinator_with_two_portals):
    entity = GuestPortalEntity(coordinator_with_two_portals, "portal-gone", "switch")
    assert entity._current_portal() is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_entity.py`
Expected: FAIL — `GuestPortalEntity.__init__` takes 2 args today (`coordinator`, `key`), not 3

- [ ] **Step 3: Rewrite `entity.py`**

```python
"""Shared entity base for the Guest Portal integration."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .api import PortalSummary
from .const import DOMAIN
from .coordinator import GuestPortalCoordinator


class GuestPortalEntity(CoordinatorEntity[GuestPortalCoordinator]):
    """Base for entities backed by one specific portal.

    Both entities for a portal hang off one device identified by the
    combination of this deployment's id and that portal's own id, so portals
    group separately on a dashboard and each survives being re-added by a
    different route (manual setup versus Supervisor discovery), same as the
    single-portal version did for the deployment as a whole.
    """

    _attr_has_entity_name = True

    def __init__(self, coordinator: GuestPortalCoordinator, portal_id: str, key: str) -> None:
        """Attach to the coordinator, a specific portal, and the shared device."""
        super().__init__(coordinator)

        self._portal_id = portal_id
        deployment_id = coordinator.data.deployment_id
        device_key = f"{deployment_id}_{portal_id}"

        self._attr_unique_id = f"{device_key}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, device_key)},
            name="Guest Portal",
            manufacturer="Home Assistant Guest Portal",
            sw_version=coordinator.data.version,
            configuration_url=coordinator.api.base_url,
        )

    def _current_portal(self) -> PortalSummary | None:
        """This entity's own portal, or None if it was deleted since the last poll."""
        for portal in self.coordinator.data.portals:
            if portal.portal_id == self._portal_id:
                return portal
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_entity.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add custom_components/ha_guest_portal/entity.py tests/test_entity.py
git commit -m "feat: give each portal its own HA device, identified by deployment + portal id"
```

### Task 29: `coordinator.py` — track `DeploymentState` instead of `PortalState`

**Files:**
- Modify: `custom_components/ha_guest_portal/coordinator.py` (full current contents 50 lines — a type-parameter change only, no logic change)
- Test: no dedicated test file exists for this class today (it is exercised indirectly through `tests/test_switch.py`/`tests/test_sensor.py`'s fixtures) — no new test needed for this task specifically; Tasks 30–31's tests exercise it.

**Interfaces:**
- Produces: `GuestPortalCoordinator(DataUpdateCoordinator[DeploymentState])` (was `[PortalState]`). No other change — `_async_update_data` already just forwards whatever `self.api.async_get_state()` returns, which Task 27 already changed to `DeploymentState`.

- [ ] **Step 1: Edit `coordinator.py`**

Change the import line from:
```python
from .api import PortalApi, PortalAuthError, PortalConnectionError, PortalState
```
to:
```python
from .api import DeploymentState, PortalApi, PortalAuthError, PortalConnectionError
```

Change the class declaration from:
```python
class GuestPortalCoordinator(DataUpdateCoordinator[PortalState]):
```
to:
```python
class GuestPortalCoordinator(DataUpdateCoordinator[DeploymentState]):
```

Change `_async_update_data`'s return type annotation from `-> PortalState:` to `-> DeploymentState:`. No other line in this file changes.

- [ ] **Step 2: Typecheck / lint the Python side**

Run whatever this project's Python type-checking command is (check `pyproject.toml`'s scripts/tool config — likely `ruff check` and possibly `mypy` or `pyright`; use the same command the project's CI/`pyproject.toml` defines rather than guessing one)
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add custom_components/ha_guest_portal/coordinator.py
git commit -m "refactor: track DeploymentState in the coordinator, not a single portal's state"
```

### Task 30: `switch.py` — one switch per portal, added and removed dynamically

**Files:**
- Modify: `custom_components/ha_guest_portal/switch.py` (full current contents 74 lines)
- Test: `tests/test_switch.py` (existing — update it substantially)

**Interfaces:**
- Produces: `async_setup_entry` creates one `GuestPortalSwitch` per portal currently in `coordinator.data.portals`, and registers a coordinator-update listener that adds a switch for any newly-seen portal id and removes the entity-registry entry for any portal id that disappears. `GuestPortalSwitch.__init__(self, coordinator, portal_id: str)` (gains `portal_id`); `is_on`/`extra_state_attributes` read `self._current_portal()` (Task 28) instead of `self.coordinator.data` directly; `available` is `False` when the portal has been removed.

- [ ] **Step 1: Write the failing test**

Read `tests/test_switch.py` in full first to match its existing `hass`/`MockConfigEntry` fixture conventions, then replace its single-switch tests with:

```python
async def test_creates_one_switch_per_portal(hass, mock_config_entry_with_two_portals):
    await hass.config_entries.async_setup(mock_config_entry_with_two_portals.entry_id)
    await hass.async_block_till_done()

    assert hass.states.get("switch.guest_portal_timothy") is not None
    assert hass.states.get("switch.guest_portal_mary") is not None
    # (Entity id suffixes above are illustrative — read how HA actually names
    # entities from `_attr_has_entity_name`/`name` in this integration and the
    # device's own name, and assert against the real generated entity ids;
    # don't hardcode a guess if the fixture's device names differ.)


async def test_adds_a_switch_when_a_new_portal_appears_on_a_later_poll(hass, mock_config_entry_with_one_portal, mock_aioresponse):
    await hass.config_entries.async_setup(mock_config_entry_with_one_portal.entry_id)
    await hass.async_block_till_done()

    entity_registry = er.async_get(hass)
    assert len(er.async_entries_for_config_entry(entity_registry, mock_config_entry_with_one_portal.entry_id)) == 2  # switch + sensor for the one portal

    # Reconfigure the mocked /api/integration/state response to include a
    # second portal, then trigger a refresh — read tests/conftest.py for
    # however this project already re-stubs a mocked HTTP response mid-test.
    ...
    coordinator = mock_config_entry_with_one_portal.runtime_data
    await coordinator.async_request_refresh()
    await hass.async_block_till_done()

    assert len(er.async_entries_for_config_entry(entity_registry, mock_config_entry_with_one_portal.entry_id)) == 4


async def test_removes_a_switch_when_its_portal_is_deleted(hass, mock_config_entry_with_two_portals, mock_aioresponse):
    await hass.config_entries.async_setup(mock_config_entry_with_two_portals.entry_id)
    await hass.async_block_till_done()

    # Re-stub /api/integration/state to report only one of the two portals now.
    ...
    coordinator = mock_config_entry_with_two_portals.runtime_data
    await coordinator.async_request_refresh()
    await hass.async_block_till_done()

    entity_registry = er.async_get(hass)
    assert len(er.async_entries_for_config_entry(entity_registry, mock_config_entry_with_two_portals.entry_id)) == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_switch.py`
Expected: FAIL — current `async_setup_entry` always creates exactly one switch

- [ ] **Step 3: Rewrite `switch.py`**

```python
"""Switch entities exposing each portal's enablement."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import GuestPortalConfigEntry
from .const import DOMAIN
from .coordinator import GuestPortalCoordinator
from .entity import GuestPortalEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up one switch per portal, and keep the set in sync as portals change."""
    coordinator = entry.runtime_data
    known_portal_ids: set[str] = set()

    def _sync_entities() -> None:
        current_ids = {portal.portal_id for portal in coordinator.data.portals}

        new_ids = current_ids - known_portal_ids
        if new_ids:
            async_add_entities([GuestPortalSwitch(coordinator, portal_id) for portal_id in new_ids])
            known_portal_ids.update(new_ids)

        removed_ids = known_portal_ids - current_ids
        if removed_ids:
            registry = er.async_get(hass)
            for portal_id in removed_ids:
                unique_id = f"{coordinator.data.deployment_id}_{portal_id}_portal"
                entity_id = registry.async_get_entity_id("switch", DOMAIN, unique_id)
                if entity_id is not None:
                    registry.async_remove(entity_id)
            known_portal_ids.difference_update(removed_ids)

    _sync_entities()
    entry.async_on_unload(coordinator.async_add_listener(_sync_entities))


class GuestPortalSwitch(GuestPortalEntity, SwitchEntity):
    """Turns one portal's guest surface on and off."""

    _attr_name = None

    def __init__(self, coordinator: GuestPortalCoordinator, portal_id: str) -> None:
        """Set up the switch for one portal."""
        super().__init__(coordinator, portal_id, "portal")
        self._optimistic: bool | None = None

    @property
    def available(self) -> bool:
        """False once this portal has been deleted."""
        return super().available and self._current_portal() is not None

    @property
    def is_on(self) -> bool:
        """Whether guests can currently reach this portal."""
        if self._optimistic is not None:
            return self._optimistic
        portal = self._current_portal()
        return portal.enabled if portal is not None else False

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Diagnostics a dashboard card can show alongside the toggle."""
        portal = self._current_portal()
        if portal is None:
            return {}
        return {
            "device_count": portal.device_count,
            "ha_link_stale": self.coordinator.data.ha_stale,
        }

    async def _async_set(self, enabled: bool) -> None:
        self._optimistic = enabled
        self.async_write_ha_state()

        try:
            await self.coordinator.api.async_set_enabled(self._portal_id, enabled)
        finally:
            self._optimistic = None
            self.async_write_ha_state()

        await self.coordinator.async_request_refresh()

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Let guests back into this portal."""
        await self._async_set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Block guests from this portal."""
        await self._async_set(False)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_switch.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add custom_components/ha_guest_portal/switch.py tests/test_switch.py
git commit -m "feat: one switch per portal, added and removed as portals change"
```

### Task 31: `sensor.py` — one last-interaction sensor per portal

**Files:**
- Modify: `custom_components/ha_guest_portal/sensor.py` (full current contents 67 lines)
- Test: `tests/test_sensor.py` (existing — update it substantially, mirroring Task 30's test restructuring)

**Interfaces:**
- Produces: `async_setup_entry` creates one `GuestPortalLastInteraction` per portal, with the same add/remove-on-poll pattern as `switch.py` (Task 30) — this is the same dynamic-entity-set logic duplicated for one platform, not shared into a helper function in this plan; if the reviewer of this task considers that duplication worth collapsing into a shared helper (e.g. in `entity.py`), that is a reasonable follow-up but is not required for this task's tests to pass, and should be raised as a suggestion rather than silently done, since Home Assistant's own platform-setup convention keeps each platform file self-contained.

- [ ] **Step 1: Write the failing test**

Read `tests/test_sensor.py` in full first, then replace its single-sensor tests with the same three-case shape as Task 30's `test_switch.py` (one-per-portal, add-on-new-poll, remove-on-deleted-poll), swapping `switch.guest_portal_*` for `sensor.guest_portal_*_last_interaction` (or whatever the real generated entity ids are — read them from the fixture, do not guess) and asserting via `hass.states.get(...)`/`entity_registry` the same way.

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_sensor.py`
Expected: FAIL — current `async_setup_entry` always creates exactly one sensor

- [ ] **Step 3: Rewrite `sensor.py`**

```python
"""Sensors reporting each portal's most recent guest interaction."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from . import GuestPortalConfigEntry
from .const import DOMAIN
from .coordinator import GuestPortalCoordinator
from .entity import GuestPortalEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: GuestPortalConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up one interaction sensor per portal, kept in sync as portals change."""
    coordinator = entry.runtime_data
    known_portal_ids: set[str] = set()

    def _sync_entities() -> None:
        current_ids = {portal.portal_id for portal in coordinator.data.portals}

        new_ids = current_ids - known_portal_ids
        if new_ids:
            async_add_entities(
                [GuestPortalLastInteraction(coordinator, portal_id) for portal_id in new_ids]
            )
            known_portal_ids.update(new_ids)

        removed_ids = known_portal_ids - current_ids
        if removed_ids:
            registry = er.async_get(hass)
            for portal_id in removed_ids:
                unique_id = f"{coordinator.data.deployment_id}_{portal_id}_last_interaction"
                entity_id = registry.async_get_entity_id("sensor", DOMAIN, unique_id)
                if entity_id is not None:
                    registry.async_remove(entity_id)
            known_portal_ids.difference_update(removed_ids)

    _sync_entities()
    entry.async_on_unload(coordinator.async_add_listener(_sync_entities))


class GuestPortalLastInteraction(GuestPortalEntity, SensorEntity):
    """When a guest of one portal last logged in or operated a device."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_translation_key = "last_interaction"

    def __init__(self, coordinator: GuestPortalCoordinator, portal_id: str) -> None:
        """Set up the sensor for one portal."""
        super().__init__(coordinator, portal_id, "last_interaction")

    @property
    def available(self) -> bool:
        """False once this portal has been deleted."""
        return super().available and self._current_portal() is not None

    @property
    def native_value(self) -> datetime | None:
        """The moment of this portal's last guest interaction, or None if there has been none."""
        portal = self._current_portal()
        if portal is None or portal.last_interaction is None:
            return None

        # The portal reports milliseconds since the epoch.
        return dt_util.utc_from_timestamp(portal.last_interaction.ts / 1000)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """What the interaction was.

        The shape is uniform across both kinds so an automation can branch on
        `kind` rather than probing for which attributes happen to exist. The
        device key is `target_entity_id`, not `entity_id`: Home Assistant reads
        a bare `entity_id` attribute as group membership.
        """
        portal = self._current_portal()
        interaction = portal.last_interaction if portal is not None else None
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_sensor.py`
Expected: PASS

- [ ] **Step 5: Run the entire Python suite**

Run: `pytest`
Expected: clean — this is the last Python task in the plan

- [ ] **Step 6: Commit**

```bash
git add custom_components/ha_guest_portal/sensor.py tests/test_sensor.py
git commit -m "feat: one last-interaction sensor per portal, added and removed as portals change"
```

---

## Final verification

- [ ] Run `pnpm vitest run && pnpm typecheck && pnpm lint` — expect entirely clean.
- [ ] Run `pytest` from the repo root — expect entirely clean.
- [ ] Run `pnpm build` — expect a clean build (this also surfaces any web-side type error the incremental per-task typechecks in Phase 6 might have missed due to a task being run in isolation from the full project).
- [ ] Manually delete the local SQLite database file (per this plan's Global Constraints — no migration path) and start the server fresh; confirm the first-launch create-portal screen appears, a created portal can be logged into as a guest, and the admin can switch between two created portals via the dropdown.
- [ ] Confirm with the project owner whether e2e test coverage (flagged as out-of-scope follow-up work in Task 25) should be tackled as an immediate next plan or deferred.


