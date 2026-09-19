# HA Guest Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A password-protected LAN web app that exposes an admin-curated subset of Home Assistant devices, with live state, deployable as a single Docker container.

**Architecture:** One Node process serves a React SPA, a small JSON API, and an SSE stream, holding one persistent WebSocket to Home Assistant. Actions go out over HA's REST API; state comes in over the WebSocket — separate failure domains, so buttons still work while the socket reconnects. A SQLite allowlist is the security boundary: the HA token never reaches a browser and no route proxies to HA.

**Tech Stack:** Node 24 LTS, TypeScript (ESM, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), Hono + `@hono/node-server`, Zod 4, `node:sqlite`, React 19, Tailwind 4, Vite, Vitest, Playwright, pnpm, Biome.

**Spec:** `docs/superpowers/specs/2026-09-18-ha-guest-portal-design.md`

## Global Constraints

- Node 24 LTS. `package.json` sets `"type": "module"` and `"engines": { "node": ">=24" }`.
- TypeScript compiler options include `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `target: "ES2022"`, `moduleResolution: "bundler"`, `verbatimModuleSyntax: true`.
- Path alias `@shared/*` → `src/shared/*`, resolved in both `tsconfig` and `vite.config.ts`.
- **No dependency may be added beyond those listed in Task 1** without stopping and flagging it. Fewer dependencies is a design goal, not an accident.
- **The HA token must never appear in any response body, SSE frame, log line, or error message.**
- Every external input — HTTP request bodies, HA WebSocket frames, env vars — is parsed with Zod at the boundary. Never cast with `as`.
- Only the `prepare` / `run` / `get` / `all` subset of `node:sqlite` may be used.
- All new code is TDD: failing test first, verify it fails, minimal implementation, verify it passes, commit.
- Commits use Conventional Commits. **Never add `Co-Authored-By` or any AI-attribution trailer.**
- `pnpm typecheck` and `pnpm test` must pass before any task is considered complete.

## Task Dependency Graph

```
T1 scaffold
 ├─> T2 shared/devices ──> T3 shared/api ──┬─> T4  store
 │                                         ├─> T11 http/auth
 │                                         └─> T12 http/sse
 └─> T5 ha/schemas ──> T6 fake-ha ──> T7 ha/connection ──┬─> T8 catalog ──┐
                                                         └─> T9 states ───┴─> T10 ha/client

T2 + T3 + T4 + T10 + T11 + T12 ──> T13 routes-guest ──> T14 routes-admin ──> T15 web shell
T15 ──> T16 guest UI ──┐
T15 ──> T17 admin UI ──┴─> T18 docker + README ──> T19 e2e
```

Parallelisable waves: **[T1]**, **[T2, T5]**, **[T3, T6]**, **[T4, T11, T12, T7]**, **[T8, T9]**, **[T10]**, **[T13]**, **[T14]**, **[T15]**, **[T16, T17]**, **[T18]**, **[T19]**.

T13 and T14 both write `src/server/app.ts` and must not run concurrently.

---

### Task 1: Project scaffold and configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.server.json`, `tsconfig.web.json`, `vite.config.ts`, `vitest.config.ts`, `biome.json`, `index.html`, `src/web/main.tsx`, `src/web/index.css`, `src/server/config.ts`, `.env.example`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/server/config.ts
  export type Config = {
    haBaseUrl: string; haToken: string;
    guestPassword: string; adminPassword: string;
    port: number; dbPath: string; trustProxy: string | undefined;
  }
  export function loadConfig(env: NodeJS.ProcessEnv): Config  // throws on invalid
  ```

**Dependencies to install (exact set — nothing else):**

```
deps:    hono @hono/node-server zod react react-dom ws
devDeps: typescript vite @vitejs/plugin-react vitest @playwright/test
         @biomejs/biome tailwindcss @tailwindcss/vite
         @types/node @types/react @types/react-dom @types/ws
         happy-dom @testing-library/react @testing-library/user-event
```

**Scripts:** `dev`, `build` (`vite build && tsc -p tsconfig.server.json`), `start`, `typecheck` (`tsc -p tsconfig.server.json --noEmit && tsc -p tsconfig.web.json --noEmit`), `test`, `test:e2e`, `lint`, `format`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/config.test.ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/server/config.ts'

const valid = {
  HA_BASE_URL: 'http://ha.local:8123', HA_TOKEN: 'tok',
  GUEST_PASSWORD: 'guest-pw', ADMIN_PASSWORD: 'admin-pw',
}

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const c = loadConfig({ ...valid })
    expect(c.port).toBe(8080)
    expect(c.dbPath).toBe('/data/portal.db')
    expect(c.trustProxy).toBeUndefined()
  })

  it('strips a trailing slash from HA_BASE_URL', () => {
    expect(loadConfig({ ...valid, HA_BASE_URL: 'http://ha.local:8123/' }).haBaseUrl)
      .toBe('http://ha.local:8123')
  })

  it.each(['HA_BASE_URL', 'HA_TOKEN', 'GUEST_PASSWORD', 'ADMIN_PASSWORD'])(
    'throws when %s is missing', (key) => {
      const env: Record<string, string> = { ...valid }
      delete env[key]
      expect(() => loadConfig(env)).toThrow()
    })

  it('rejects identical guest and admin passwords', () => {
    expect(() => loadConfig({ ...valid, ADMIN_PASSWORD: 'guest-pw' })).toThrow(/must differ/i)
  })

  it('rejects a password shorter than 8 characters', () => {
    expect(() => loadConfig({ ...valid, GUEST_PASSWORD: 'short' })).toThrow()
  })

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ ...valid, PORT: 'abc' })).toThrow()
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run test/unit/config.test.ts`
Expected: FAIL — cannot resolve `src/server/config.ts`.

- [ ] **Step 3: Scaffold the project and implement `loadConfig`**

Create the config files per the constraints above, then:

```ts
// src/server/config.ts
import { z } from 'zod'

const schema = z.object({
  HA_BASE_URL: z.url().transform((s) => s.replace(/\/+$/, '')),
  HA_TOKEN: z.string().min(1),
  GUEST_PASSWORD: z.string().min(8),
  ADMIN_PASSWORD: z.string().min(8),
  PORT: z.coerce.number().int().positive().default(8080),
  DB_PATH: z.string().default('/data/portal.db'),
  TRUST_PROXY: z.string().optional(),
}).refine((v) => v.GUEST_PASSWORD !== v.ADMIN_PASSWORD, {
  message: 'GUEST_PASSWORD and ADMIN_PASSWORD must differ',
})

export type Config = { /* as in Interfaces above */ }

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const r = schema.safeParse(env)
  if (!r.success) throw new Error(`Invalid configuration:\n${z.prettifyError(r.error)}`)
  const v = r.data
  return {
    haBaseUrl: v.HA_BASE_URL, haToken: v.HA_TOKEN,
    guestPassword: v.GUEST_PASSWORD, adminPassword: v.ADMIN_PASSWORD,
    port: v.PORT, dbPath: v.DB_PATH, trustProxy: v.TRUST_PROXY,
  }
}
```

Note: the error message must never interpolate the parsed values — only field names.

- [ ] **Step 4: Verify tests pass and typecheck is clean**

Run: `pnpm vitest run test/unit/config.test.ts && pnpm typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: scaffold project and add validated configuration loader"
```

---

### Task 2: The security boundary — domain/action table

**Files:**
- Create: `src/shared/devices.ts`
- Test: `test/unit/devices.test.ts`

**Interfaces:**
- Consumes: Task 1 scaffold.
- Produces:
  ```ts
  export const DOMAIN_ACTIONS: {
    readonly light: readonly ['turn_on','turn_off','toggle']
    readonly switch: readonly ['turn_on','turn_off','toggle']
    readonly fan: readonly ['turn_on','turn_off','toggle']
    readonly input_boolean: readonly ['turn_on','turn_off','toggle']
    readonly cover: readonly ['open_cover','close_cover','stop_cover']
    readonly lock: readonly ['lock','unlock']
  }
  export type SupportedDomain = keyof typeof DOMAIN_ACTIONS
  export type DeviceAction = typeof DOMAIN_ACTIONS[SupportedDomain][number]
  export function parseDomain(entityId: string): SupportedDomain | null
  export function isSupportedEntity(entityId: string): boolean
  export type ValidationFailure =
    | { ok: false; reason: 'not_allowlisted' | 'unsupported_domain' | 'action_not_valid_for_domain' | 'action_not_permitted' }
  export type ValidationSuccess = { ok: true; domain: SupportedDomain; service: DeviceAction }
  export function validateAction(
    entityId: string, action: string,
    allowlist: ReadonlyMap<string, readonly string[]>,   // entityId -> allowed_actions
  ): ValidationSuccess | ValidationFailure
  ```

**Why this is its own task:** this function is the entire security boundary. It is pure, has no dependencies, and gets exhaustive table-driven tests.

- [ ] **Step 1: Write the failing tests**

```ts
// test/unit/devices.test.ts
import { describe, expect, it } from 'vitest'
import { DOMAIN_ACTIONS, parseDomain, validateAction } from '../../src/shared/devices.ts'

const allow = (m: Record<string, string[]>) => new Map(Object.entries(m))

describe('parseDomain', () => {
  it('extracts a supported domain', () => expect(parseDomain('light.porch')).toBe('light'))
  it('returns null for an unsupported domain', () => expect(parseDomain('climate.hall')).toBeNull())
  it('returns null for a malformed id', () => expect(parseDomain('nodot')).toBeNull())
  it('returns null for an empty object id', () => expect(parseDomain('light.')).toBeNull())
})

describe('validateAction — exhaustive domain x action matrix', () => {
  const allDomains = Object.keys(DOMAIN_ACTIONS) as (keyof typeof DOMAIN_ACTIONS)[]
  const allActions = [...new Set(allDomains.flatMap((d) => [...DOMAIN_ACTIONS[d]]))]

  for (const domain of allDomains) {
    for (const action of allActions) {
      const entityId = `${domain}.thing`
      const legal = (DOMAIN_ACTIONS[domain] as readonly string[]).includes(action)
      it(`${legal ? 'permits' : 'rejects'} ${action} on ${domain}`, () => {
        const r = validateAction(entityId, action, allow({ [entityId]: allActions }))
        expect(r.ok).toBe(legal)
        if (!r.ok && !legal) expect(r.reason).toBe('action_not_valid_for_domain')
      })
    }
  }
})

describe('validateAction — gates', () => {
  it('rejects an entity absent from the allowlist', () => {
    const r = validateAction('light.porch', 'turn_on', allow({ 'light.other': ['turn_on'] }))
    expect(r).toEqual({ ok: false, reason: 'not_allowlisted' })
  })

  it('rejects an unsupported domain even when allowlisted', () => {
    const r = validateAction('climate.hall', 'turn_on', allow({ 'climate.hall': ['turn_on'] }))
    expect(r).toEqual({ ok: false, reason: 'unsupported_domain' })
  })

  it('rejects an action the row does not permit', () => {
    const r = validateAction('lock.front', 'lock', allow({ 'lock.front': ['unlock'] }))
    expect(r).toEqual({ ok: false, reason: 'action_not_permitted' })
  })

  it('permits unlock while lock is withheld', () => {
    expect(validateAction('lock.front', 'unlock', allow({ 'lock.front': ['unlock'] })))
      .toEqual({ ok: true, domain: 'lock', service: 'unlock' })
  })

  it('cannot aim a lock service at an entity exposed as a light', () => {
    const r = validateAction('light.porch', 'unlock', allow({ 'light.porch': ['unlock'] }))
    expect(r).toEqual({ ok: false, reason: 'action_not_valid_for_domain' })
  })

  it('rejects an entity id carrying a service separator', () => {
    const r = validateAction('light.porch/../lock/unlock', 'turn_on', allow({ 'light.porch/../lock/unlock': ['turn_on'] }))
    expect(r.ok).toBe(false)
  })
})
```

Note the last case: `parseDomain` must reject object IDs that are not
`[a-z0-9_]+`, so a crafted entity ID cannot escape into the service URL path.

- [ ] **Step 2: Run tests and verify they fail**

Run: `pnpm vitest run test/unit/devices.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/shared/devices.ts`**

Implement per the Interfaces block. `parseDomain` must match the entity ID
against `/^([a-z_]+)\.([a-z0-9_]+)$/` and return the domain only if it is a key
of `DOMAIN_ACTIONS`. `validateAction` applies the gates strictly in order:
allowlist → domain → domain permits action → row permits action.

- [ ] **Step 4: Verify tests pass**

Run: `pnpm vitest run test/unit/devices.test.ts && pnpm typecheck`
Expected: PASS (48+ matrix cases plus the gate cases).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add domain/action allowlist validation"
```

---

### Task 3: Shared API schemas

**Files:**
- Create: `src/shared/api.ts`
- Test: `test/unit/api-schemas.test.ts`

**Interfaces:**
- Consumes: Task 2 (`DeviceAction`).
- Produces:
  ```ts
  export type Role = 'guest' | 'admin'
  export const LoginRequest: z.ZodType<{ password: string }>
  export const SessionResponse: z.ZodType<{ role: Role }>

  export type DeviceState = { state: string; attributes: Record<string, unknown>; stale: boolean }
  export type Device = {
    entityId: string; label: string; domain: string;
    allowedActions: string[]; sortOrder: number; state: DeviceState
  }
  export const DevicesResponse: z.ZodType<{ devices: Device[]; stale: boolean }>

  export type CatalogEntry = {
    entityId: string; name: string; area: string | null; domain: string; supported: boolean
  }
  export const CatalogResponse: z.ZodType<{ entities: CatalogEntry[] }>

  export type AllowlistRow = { entityId: string; label: string; allowedActions: string[]; sortOrder: number }
  export const AllowlistPutRequest: z.ZodType<{ devices: AllowlistRow[] }>
  export const AllowlistResponse: z.ZodType<{ devices: AllowlistRow[]; orphaned: string[] }>

  export type SseFrame =
    | { type: 'snapshot'; devices: Device[]; stale: boolean }
    | { type: 'patch'; devices: Device[] }
    | { type: 'degraded'; stale: boolean }
  export const SseFrameSchema: z.ZodType<SseFrame>
  ```

- [ ] **Step 1: Write the failing tests** — assert `AllowlistPutRequest` rejects duplicate `entityId` values, rejects an empty `label`, rejects an `allowedActions` entry not present in `DOMAIN_ACTIONS` for that entity's domain, and accepts a valid payload. Assert `SseFrameSchema` round-trips one frame of each variant.

- [ ] **Step 2: Run and verify failure** — `pnpm vitest run test/unit/api-schemas.test.ts`

- [ ] **Step 3: Implement `src/shared/api.ts`** using Zod 4, with `.check()` / `.superRefine()` for the cross-field duplicate and domain checks.

- [ ] **Step 4: Verify** — `pnpm vitest run test/unit/api-schemas.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit** — `git commit -m "feat: add shared API schemas"`

---

### Task 4: SQLite store

**Files:**
- Create: `src/server/store/db.ts`, `src/server/store/allowlist.ts`, `src/server/store/auditlog.ts`
- Test: `test/unit/store.test.ts`

**Interfaces:**
- Consumes: Task 3 (`AllowlistRow`).
- Produces:
  ```ts
  // db.ts
  import type { DatabaseSync } from 'node:sqlite'
  export function openDb(path: string): DatabaseSync   // creates tables if absent; ':memory:' supported

  // allowlist.ts
  export type AllowlistChangeListener = (entityIds: string[]) => void
  export class AllowlistStore {
    constructor(db: DatabaseSync)
    list(): AllowlistRow[]                       // ordered by sortOrder, then entityId
    entityIds(): string[]
    asMap(): Map<string, readonly string[]>      // feeds validateAction
    replace(rows: AllowlistRow[]): void          // transactional; fires listeners
    onChange(fn: AllowlistChangeListener): () => void   // returns unsubscribe
  }

  // auditlog.ts
  export type AuditEntry = { ts: number; entityId: string; action: string; role: Role; ok: boolean }
  export class AuditLog {
    constructor(db: DatabaseSync)
    record(e: AuditEntry): void
    recent(limit: number): AuditEntry[]          // newest first
  }
  ```

**Schema:** exactly as in the spec's Data model section.

- [ ] **Step 1: Write the failing tests** against `openDb(':memory:')` covering: tables created idempotently (calling `openDb` twice on one file is safe); `replace` is atomic (a payload with a duplicate primary key leaves the previous contents intact); `replace` fires `onChange` exactly once with the new entity IDs; `onChange` unsubscribe works; `list()` ordering; `asMap()` shape; `allowedActions` survives the JSON round-trip; `AuditLog.record` then `recent(10)` returns newest-first with `ok` mapped back to a boolean.

- [ ] **Step 2: Run and verify failure** — `pnpm vitest run test/unit/store.test.ts`

- [ ] **Step 3: Implement.** Use `db.exec('BEGIN')` / `COMMIT` / `ROLLBACK` around `replace`. Fire listeners only after a successful commit.

- [ ] **Step 4: Verify** — `pnpm vitest run test/unit/store.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit** — `git commit -m "feat: add SQLite allowlist and audit log stores"`

---

### Task 5: Home Assistant frame schemas

**Files:**
- Create: `src/server/ha/schemas.ts`
- Test: `test/unit/ha-schemas.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const AuthRequired: z.ZodType<{ type: 'auth_required'; ha_version: string }>
  export const AuthOk: z.ZodType<{ type: 'auth_ok'; ha_version: string }>
  export const AuthInvalid: z.ZodType<{ type: 'auth_invalid'; message: string }>
  export const ResultFrame: z.ZodType<{ type: 'result'; id: number; success: boolean; result?: unknown; error?: { code: string; message: string } }>
  export const PongFrame: z.ZodType<{ type: 'pong'; id: number }>

  export type CompressedState = { s?: string; a?: Record<string, unknown>; c?: unknown; lc?: number; lu?: number }
  export type EntityEvent = {
    a?: Record<string, CompressedState>
    c?: Record<string, { '+'?: CompressedState; '-'?: { a?: string[] } }>
    r?: string[]
  }
  export const EventFrame: z.ZodType<{ type: 'event'; id: number; event: EntityEvent }>
  export const InboundFrame: z.ZodType<...>   // discriminated union of the above

  export const RegistryEntity: z.ZodType<{
    entity_id: string; name: string | null; original_name: string | null
    area_id: string | null; device_id: string | null
    disabled_by: string | null; hidden_by: string | null; entity_category: string | null
  }>
  export const RegistryDevice: z.ZodType<{ id: string; name: string | null; name_by_user: string | null; area_id: string | null }>
  export const RegistryArea: z.ZodType<{ area_id: string; name: string }>
  ```

**Critical:** the registry schemas must use `.loose()` (passthrough) — HA adds
fields across releases and a strict schema would break on upgrade. The event
schemas must tolerate `c` being either a string or an object.

- [ ] **Step 1: Write the failing tests** using real captured frame shapes from the spec's "Compressed state wire format" section. Include: an `a`-only snapshot frame; a `c` frame with both `+` and `-`; an `r` frame; a `+` containing `lu` but no `lc`; a registry entity carrying an unknown extra field (must parse); a registry entity missing `area_id` (must fail — the field is present-but-null in HA, never absent).

- [ ] **Step 2: Run and verify failure** — `pnpm vitest run test/unit/ha-schemas.test.ts`

- [ ] **Step 3: Implement `src/server/ha/schemas.ts`.**

- [ ] **Step 4: Verify** — `pnpm vitest run test/unit/ha-schemas.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit** — `git commit -m "feat: add Home Assistant frame schemas"`

---

### Task 6: Fake Home Assistant server

**Files:**
- Create: `test/fake-ha.ts`
- Test: `test/unit/fake-ha.test.ts`

**Interfaces:**
- Consumes: Task 5 schemas (for self-validation of emitted frames).
- Produces:
  ```ts
  export type FakeEntity = {
    entityId: string; name?: string; areaId?: string | null; deviceId?: string | null
    state: string; attributes?: Record<string, unknown>
    disabledBy?: string | null; hiddenBy?: string | null
  }
  export type ServiceCall = { domain: string; service: string; body: unknown; authorization: string | undefined }

  export class FakeHomeAssistant {
    static async start(opts?: { token?: string }): Promise<FakeHomeAssistant>
    readonly baseUrl: string          // http://127.0.0.1:<port>
    readonly token: string
    seed(entities: FakeEntity[], areas: { areaId: string; name: string }[], devices?: { id: string; name: string; areaId: string | null }[]): void
    setState(entityId: string, state: string, attributes?: Record<string, unknown>): void
    removeEntity(entityId: string): void
    readonly serviceCalls: ServiceCall[]
    failNextServiceCall(status: number): void
    subscribedEntityIds(): string[] | null     // what the client last subscribed to
    drop(): void                      // hard-close all sockets, simulating an HA restart
    rejectAuth(on: boolean): void
    async stop(): Promise<void>
  }
  ```

**This is the keystone test fixture.** It must implement: the `auth_required` →
`auth` → `auth_ok` / `auth_invalid` handshake; `get_config`; the three registry
list commands; `subscribe_entities` (honouring the `entity_ids` filter, sending
an `a` snapshot immediately then `c` diffs on `setState`, and `r` on
`removeEntity`); `ping` → `pong`; and an HTTP `POST /api/services/:domain/:service`
that records the call and checks the bearer token.

Diffs must be genuinely minimal — only changed keys under `+`, removed attribute
names under `-`.`lc` is sent only when the state value itself changed.

- [ ] **Step 1: Write the failing test** — a raw `ws` client that completes the handshake, calls `config/area_registry/list`, subscribes to one entity, asserts the `a` snapshot arrives, calls `setState`, and asserts a `c` frame with a minimal `+`. Plus: `rejectAuth(true)` yields `auth_invalid`; a service call with a wrong bearer token returns 401; `subscribedEntityIds()` reflects the filter.

- [ ] **Step 2: Run and verify failure** — `pnpm vitest run test/unit/fake-ha.test.ts`

- [ ] **Step 3: Implement `test/fake-ha.ts`** using `ws` and `node:http`, binding to port 0 and reading the assigned port.

- [ ] **Step 4: Verify** — `pnpm vitest run test/unit/fake-ha.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit** — `git commit -m "test: add scriptable fake Home Assistant server"`

---

### Task 7: HA WebSocket connection

**Files:**
- Create: `src/server/ha/connection.ts`
- Test: `test/integration/ha-connection.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 6.
- Produces:
  ```ts
  export type ConnectionStatus = 'connecting' | 'ready' | 'disconnected'
  export type HaConnectionOptions = {
    baseUrl: string; token: string
    wsUrl?: string             // explicit override; default `${baseUrl}/api/websocket` with http->ws
    reconnectBaseMs?: number   // default 500
    reconnectMaxMs?: number    // default 30_000
    pingIntervalMs?: number    // default 20_000
  }
  export class HaConnection {
    constructor(opts: HaConnectionOptions)
    get status(): ConnectionStatus
    start(): void
    async stop(): Promise<void>
    async send<T>(payload: Record<string, unknown>, schema: z.ZodType<T>): Promise<T>  // adds id, awaits result, parses
    subscribe(payload: Record<string, unknown>, onEvent: (e: EntityEvent) => void): Promise<{ unsubscribe: () => Promise<void> }>
    onStatus(fn: (s: ConnectionStatus) => void): () => void
  }
  ```

**Also in this task — the dual-deployment accommodation.** Add an optional
`HA_WS_URL` to `src/server/config.ts` and its Zod schema (`z.url().optional()`),
surfaced as `Config.haWsUrl: string | undefined`. When unset, the connection
derives the WebSocket URL from `baseUrl` as `${baseUrl}/api/websocket`, upgrading
the scheme `http`→`ws` and `https`→`wss`. When set, it is used verbatim.

This exists because the Home Assistant add-on deployment (Task 20) reaches HA
through the Supervisor proxy at `ws://supervisor/core/websocket`, which does
**not** follow the `${base}/api/websocket` convention a direct connection uses.
An explicit override beats scheme detection or path heuristics.

Also add to `loadConfig`: reject an `HA_BASE_URL` whose hostname ends in
`.local` with a message stating that mDNS does not resolve inside containers and
that a LAN IP should be used. Test it. This turns the single most likely
first-run failure into a named error instead of a connection timeout.

**Requirements:** monotonically increasing message IDs; a pending-request map
rejecting all in-flight promises on disconnect; exponential backoff with jitter,
capped; `ping` every `pingIntervalMs` with a missed-pong forcing a reconnect;
`auth_invalid` is fatal and must **not** trigger reconnect (retrying a bad token
forever is how you get locked out). No log line may contain the token.

- [ ] **Step 1: Write the failing tests** — connects and reaches `ready`; `send` resolves with the parsed result; `send` rejects on an HA error frame; `drop()` moves status to `disconnected` then back to `ready` without intervention; in-flight `send` promises reject on drop rather than hanging; `rejectAuth(true)` yields status `disconnected` with no reconnect attempts; `stop()` is idempotent and leaves no open handles.

- [ ] **Step 2: Run and verify failure** — `pnpm vitest run test/integration/ha-connection.test.ts`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify** — `pnpm vitest run test/integration/ha-connection.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit** — `git commit -m "feat: add resilient Home Assistant WebSocket connection"`

---

### Task 8: Entity catalog

**Files:**
- Create: `src/server/ha/catalog.ts`
- Test: `test/integration/ha-catalog.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 6, 7; Task 2 (`isSupportedEntity`).
- Produces:
  ```ts
  export async function fetchCatalog(conn: HaConnection): Promise<CatalogEntry[]>
  ```

**Rules:** area resolves as `entity.area_id ?? device(entity.device_id).area_id`;
display name is `entity.name ?? entity.original_name ?? entityId`; device name
prefers `name_by_user ?? name`; entries with a non-null `disabled_by` or
`hidden_by` are excluded; `supported` is `isSupportedEntity(entityId)`; results
are sorted by name. Unsupported entities are **included but flagged**, so the
picker can grey them out rather than mysteriously omitting them.

- [ ] **Step 1: Write the failing tests** — entity area wins over device area; device area is inherited when the entity has none; area is `null` when neither has one; disabled and hidden entries are excluded; a `climate.*` entity appears with `supported: false`; name fallback chain.

- [ ] **Step 2–5:** run/fail, implement, verify, commit (`feat: add HA entity catalog with area resolution`).

---

### Task 9: State cache and subscription

**Files:**
- Create: `src/server/ha/states.ts`
- Test: `test/integration/ha-states.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 6, 7.
- Produces:
  ```ts
  export type CachedState = { state: string; attributes: Record<string, unknown>; lastUpdated: number }
  export type StateChangeListener = (changed: Map<string, CachedState>) => void
  export class StateCache {
    constructor(conn: HaConnection)
    get stale(): boolean
    get(entityId: string): CachedState | undefined
    all(): Map<string, CachedState>
    async setEntityIds(ids: string[]): Promise<void>  // unsubscribe + resubscribe + rebroadcast
    onChange(fn: StateChangeListener): () => void
    onStaleChange(fn: (stale: boolean) => void): () => void
  }
  ```

**The compressed-diff application is the sharpest edge in this codebase.**
Apply `+` by merging `s` and merging `a` into existing attributes; apply `-` by
deleting the attribute names listed in `-.a`. Remember: at event level `a` means
*added entities*, but inside `+` it means *attributes*.

On disconnect, set `stale = true` and notify — do not clear the cache. On
reconnect, re-subscribe and replace the cache wholesale from the fresh `a`
snapshot, then set `stale = false`. Never apply a delta received before a
snapshot.

- [ ] **Step 1: Write the failing tests**

Cover, at minimum:
- initial `a` snapshot populates the cache
- a `+` with only `s` changes state and leaves attributes intact
- a `+` with an `a` sub-key merges attributes without dropping existing ones
- a `-` with `a: ['brightness']` deletes only that attribute
- an `r` frame removes the entity from the cache
- `drop()` sets `stale` true, fires `onStaleChange`, and **retains** values
- reconnect clears `stale` and replaces the cache from the new snapshot
- a state change occurring *while disconnected* is reflected after reconnect
- `setEntityIds` causes a real resubscribe — assert via `fake.subscribedEntityIds()`
- `setEntityIds` fires `onChange` with the new snapshot

- [ ] **Step 2–5:** run/fail, implement, verify, commit (`feat: add HA state cache with staleness tracking`).

---

### Task 10: HA client façade

**Files:**
- Create: `src/server/ha/client.ts`
- Test: `test/integration/ha-client.test.ts`

**Interfaces:**
- Consumes: Tasks 7, 8, 9; Task 1 (`Config`).
- Produces:
  ```ts
  export type ActionResult = { ok: true } | { ok: false; status: number; message: string }
  export class HaClient {
    static create(cfg: Pick<Config, 'haBaseUrl' | 'haToken'>): HaClient
    start(): void
    async stop(): Promise<void>
    get stale(): boolean
    async getCatalog(): Promise<CatalogEntry[]>
    getStates(): ReadonlyMap<string, Readonly<CachedState>>   // superseded: see Task 9 immutability ruling
    async setWatchedEntities(ids: string[]): Promise<void>
    async callAction(domain: SupportedDomain, service: DeviceAction, entityId: string): Promise<ActionResult>
    onChange(fn: StateChangeListener): () => void
    onStaleChange(fn: (stale: boolean) => void): () => void
  }
  ```

`callAction` uses **REST**, not the WebSocket: `POST {haBaseUrl}/api/services/{domain}/{service}` with a bearer token and `{"entity_id": entityId}`. It must succeed even when `stale === true`. Non-2xx responses return `ok: false` with the status; the HA token must never appear in the returned message.

- [ ] **Step 1: Write the failing tests** — `callAction` reaches the fake's REST endpoint with the right bearer token and body; it still works after `drop()` while the socket is down; `failNextServiceCall(502)` produces `{ok:false, status:502}`; the error message contains no token substring; `getCatalog` returns catalog entries; `setWatchedEntities` propagates to the cache.

- [ ] **Step 2–5:** run/fail, implement, verify, commit (`feat: add HA client facade`).

---

### Task 11: Sessions, login, and rate limiting

**Files:**
- Create: `src/server/http/auth.ts`
- Test: `test/unit/auth.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Config`), Task 3 (`Role`).
- Produces:
  ```ts
  export const SESSION_COOKIE = 'hagp_session'
  export class SessionStore {
    constructor(opts?: { ttlMs?: number; now?: () => number })  // ttl default 30 days, sliding
    create(role: Role): string
    get(id: string): Role | undefined     // refreshes expiry
    destroy(id: string): void
    sweep(): void
  }
  export class LoginRateLimiter {
    constructor(opts?: { perIpMax?: number; globalMax?: number; windowMs?: number; now?: () => number })
    check(ip: string): { allowed: true } | { allowed: false; retryAfterSec: number }
    recordFailure(ip: string): void
    recordSuccess(ip: string): void       // clears that IP's counter
  }
  export function verifyPassword(supplied: string, expected: string): boolean   // timing-safe
  export function classify(supplied: string, cfg: Config): Role | null
  export function clientIp(rawSocketIp: string, forwardedFor: string | undefined, trustProxy: string | undefined): string
  ```

**Defaults:** `perIpMax` 10, `globalMax` 60, `windowMs` 15 minutes.

`verifyPassword` hashes both sides with SHA-256 and compares with
`crypto.timingSafeEqual`, so the comparison is constant-time and length-safe.

`clientIp` returns the socket IP unless `trustProxy` is set; only then may it
read the last hop of `X-Forwarded-For`. Never trust the header by default.

- [ ] **Step 1: Write the failing tests** — a session round-trips and expires past TTL; TTL slides on access; `destroy` works; session IDs are unique across 1000 creations and at least 32 bytes of entropy; `classify` returns `'admin'` for the admin password and `'guest'` for the guest one and `null` otherwise; `verifyPassword` returns false for a prefix of the correct password (`'admin-p'` vs `'admin-pw'`); the per-IP limiter blocks after 10 failures and `recordSuccess` clears it; the global ceiling blocks a spread of distinct IPs; `clientIp` ignores `X-Forwarded-For` when `trustProxy` is undefined and honours it when set.

- [ ] **Step 2–5:** run/fail, implement, verify, commit (`feat: add session store, password check and login rate limiting`).

---

### Task 12: SSE hub

**Files:**
- Create: `src/server/http/sse.ts`
- Test: `test/unit/sse.test.ts`

**Interfaces:**
- Consumes: Task 3 (`SseFrame`).
- Produces:
  ```ts
  import type { ServerResponse } from 'node:http'
  export class SseHub {
    constructor(opts?: { heartbeatMs?: number })   // default 25_000
    add(res: ServerResponse): () => void           // writes headers, returns a remover
    broadcast(frame: SseFrame): void
    send(res: ServerResponse, frame: SseFrame): void
    get clientCount(): number
    close(): void
  }
  ```

Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`. Frames are written as `data: <json>\n\n`; heartbeats as `: ping\n\n`. Removal must be idempotent and must not throw on an already-destroyed response.

- [ ] **Step 1: Write the failing tests** using a real `node:http` server and an `EventSource`-shaped raw client: headers are correct; a broadcast reaches two clients; a disconnected client is dropped and `clientCount` falls; a heartbeat is emitted on a short interval; `broadcast` after a client destroys its socket does not throw; `close()` ends all responses.

- [ ] **Step 2–5:** run/fail, implement, verify, commit (`feat: add SSE fan-out hub`).

---

### Task 13: Guest routes

**Files:**
- Create: `src/server/http/routes-guest.ts`, `src/server/app.ts`, `src/server/index.ts`
- Test: `test/integration/routes-guest.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 4, 10, 11, 12.
- Produces:
  ```ts
  export type Deps = {
    cfg: Config; ha: HaClient; allowlist: AllowlistStore; audit: AuditLog
    sessions: SessionStore; limiter: LoginRateLimiter; hub: SseHub
  }
  export function createApp(deps: Deps): Hono
  ```

Routes: `POST /api/login`, `POST /api/logout`, `GET /api/session`, `GET /api/devices`, `POST /api/devices/:entityId/:action`, `GET /api/stream`. Plus static SPA serving with an index fallback for non-`/api` paths.

`src/server/index.ts` is the composition root: load config, open the DB, construct everything, wire `allowlist.onChange` → `ha.setWatchedEntities`, wire `ha.onChange` → `hub.broadcast({type:'patch'})` and `ha.onStaleChange` → `hub.broadcast({type:'degraded'})`, then listen. It must also handle `SIGTERM` by closing the hub and stopping the HA client.

The action route: resolve the session → `validateAction(entityId, action, allowlist.asMap())` → on failure record an audit row with `ok: false` and return 403 (404 for `not_allowlisted`, so the API does not confirm which entities exist) → on success `ha.callAction(...)`, record the audit row, return the result.

- [ ] **Step 1: Write the failing tests**

- unauthenticated requests to `/api/devices`, `/api/stream` and the action route all return 401
- login with the guest password sets an httpOnly `SameSite=Lax` cookie and returns `{role:'guest'}`
- login with the admin password returns `{role:'admin'}`
- login with a wrong password returns 401 and records a rate-limiter failure
- 11 failed logins from one IP return 429 with `Retry-After`
- `GET /api/devices` returns only allowlisted entities, with live state from the fake
- `POST /api/devices/light.porch/turn_on` reaches the fake's service endpoint and appends an `action_log` row with `ok: 1`
- `POST /api/devices/light.notexposed/turn_on` returns 404, makes **no** service call, and appends an `action_log` row with `ok: 0`
- `POST /api/devices/light.porch/unlock` returns 403 and makes no service call
- `POST /api/devices/lock.front/lock` returns 403 when the row permits only `unlock`
- `GET /api/stream` emits a `snapshot` frame immediately, then a `patch` after `fake.setState`, then `degraded` after `fake.drop()`
- changing the allowlist causes the stream to emit a fresh `snapshot`

- [ ] **Step 2–5:** run/fail, implement, verify, commit (`feat: add guest API routes and server composition root`).

---

### Task 14: Admin routes

**Files:**
- Create: `src/server/http/routes-admin.ts`
- Modify: `src/server/app.ts` (mount the admin router)
- Test: `test/integration/routes-admin.test.ts`

**Interfaces:**
- Consumes: Task 13 (`Deps`), Tasks 3, 4, 10.
- Produces: `export function mountAdminRoutes(app: Hono, deps: Deps): void`

Routes: `GET /api/admin/entities` (catalog), `GET /api/admin/allowlist`, `PUT /api/admin/allowlist`. All require `role === 'admin'`; a guest session gets 403, no session gets 401.

`GET /api/admin/allowlist` returns `orphaned`: allowlisted entity IDs absent from the current catalog, so the UI can flag a device renamed in HA rather than failing silently.

`PUT` validates with `AllowlistPutRequest`, rejects unsupported domains with 400, calls `allowlist.replace()`, and — via the `onChange` wiring — causes a resubscribe and a fresh snapshot to all SSE clients.

- [ ] **Step 1: Write the failing tests** — role gating on all three routes; the catalog includes areas and `supported` flags; `PUT` persists and round-trips through `GET`; `PUT` with a `climate.*` entity returns 400; `PUT` with a duplicate entity ID returns 400; `PUT` with an `allowedActions` entry illegal for the domain returns 400; after `PUT`, `fake.subscribedEntityIds()` reflects the new set; `orphaned` lists an allowlisted entity the fake no longer reports.

- [ ] **Step 2–5:** run/fail, implement, verify, commit (`feat: add admin catalog and allowlist routes`).

---

### Task 15: Web shell — SSE store, API client, login

**Files:**
- Create: `src/web/api.ts`, `src/web/store.ts`, `src/web/App.tsx`, `src/web/routes/Login.tsx`
- Modify: `src/web/main.tsx`
- Test: `test/unit/web-store.test.ts`

**Interfaces:**
- Consumes: Task 3 schemas.
- Produces:
  ```ts
  // api.ts — every response parsed with its Zod schema
  export async function login(password: string): Promise<{ role: Role }>
  export async function logout(): Promise<void>
  export async function getSession(): Promise<{ role: Role } | null>
  export async function getDevices(): Promise<{ devices: Device[]; stale: boolean }>
  export async function performAction(entityId: string, action: string): Promise<void>
  export async function getCatalog(): Promise<CatalogEntry[]>
  export async function getAllowlist(): Promise<{ devices: AllowlistRow[]; orphaned: string[] }>
  export async function putAllowlist(devices: AllowlistRow[]): Promise<void>

  // store.ts
  export type DeviceStoreSnapshot = { devices: Device[]; stale: boolean; connected: boolean }
  export function connectDeviceStore(): () => void          // opens EventSource, returns disconnect
  export function useDeviceStore(): DeviceStoreSnapshot     // useSyncExternalStore
  ```

The store must return a **referentially stable** snapshot when nothing changed — `useSyncExternalStore` will loop infinitely otherwise. Cache the snapshot object and only rebuild it inside `applyFrame`. On `EventSource` error, set `connected: false`; the browser reconnects automatically, and the server's `snapshot` frame re-establishes truth.

Routing is a `pathname` check in `App.tsx`: `/admin` renders Admin (admin role only), everything else renders Guest; no session renders Login.

- [ ] **Step 1: Write the failing tests** — `applyFrame` with `snapshot` replaces the device list; `patch` updates only the named devices and leaves others untouched; `degraded` sets `stale` on every device; the snapshot is referentially equal across two reads with no intervening frame; a malformed frame is ignored rather than throwing.

- [ ] **Step 2–5:** run/fail, implement, verify, commit (`feat: add web SSE store, API client and login screen`).

---

### Task 16: Guest UI

**Files:**
- Create: `src/web/routes/Guest.tsx`, `src/web/components/{ToggleTile,CoverTile,LockTile,StaleBadge}.tsx`
- Test: `test/unit/guest-ui.test.tsx`

**Interfaces:**
- Consumes: Task 15 store and API client.
- Produces: `export function Guest(): JSX.Element`

Phone-first grid. `ToggleTile` for `light`/`switch`/`fan`/`input_boolean`. `CoverTile` with open/stop/close and transitional `opening`/`closing` rendering. `LockTile` rendered distinctly, requiring a confirm step for `unlock` only. Tiles are optimistic on press but reconcile to the next `patch`; a failed action reverts and surfaces an inline error. Stale devices render a visibly unknown state — never a plausible value.

- [ ] **Step 1: Write the failing tests** with Testing Library — a toggle tile shows on/off from state; pressing it calls `performAction` with `turn_on` when off; a cover shows three controls and `opening` renders a transitional state; a lock's unlock button requires a second confirming press before `performAction` fires, while lock fires immediately; a stale device renders the unknown treatment and disables its controls; a failing action reverts the optimistic state and shows an error.

- [ ] **Step 2–5:** run/fail, implement, verify, commit (`feat: add guest device tiles`).

---

### Task 17: Admin UI and entity picker

**Files:**
- Create: `src/web/routes/Admin.tsx`, `src/web/components/EntityPicker.tsx`
- Test: `test/unit/entity-picker.test.tsx`

**Interfaces:**
- Consumes: Task 15.
- Produces:
  ```ts
  export function EntityPicker(props: {
    entities: CatalogEntry[]; exclude: string[]
    onSelect: (e: CatalogEntry) => void
  }): JSX.Element
  ```

Combobox behaviour: a text input filters on friendly name **and** entity ID, case-insensitively; each row shows the name with the area as a subtitle and the entity ID as muted secondary text; unsupported entries are shown disabled with a reason. Keyboard: ArrowDown/ArrowUp move the active option (wrapping), Enter selects, Escape closes, Tab closes without selecting. ARIA: `role="combobox"` with `aria-expanded` and `aria-controls` on the input, `role="listbox"` on the list, `role="option"` with `aria-selected` on rows, and `aria-activedescendant` pointing at the active row. The active row scrolls into view.

The Admin screen lists current devices with editable labels, per-action checkboxes constrained to the entity's domain, drag-free reordering (up/down buttons), a remove button, an orphaned-row warning, and a Save button calling `putAllowlist`.

- [ ] **Step 1: Write the failing tests** — typing `porch` matches by name; typing `light.por` matches by entity ID; matching is case-insensitive; already-exposed entities are excluded; unsupported entries render disabled and are not selectable; ArrowDown then Enter selects the first match; ArrowUp from the first option wraps to the last; Escape closes without selecting; `aria-activedescendant` tracks the active option; the area subtitle renders, and shows a placeholder when the area is null.

- [ ] **Step 2–5:** run/fail, implement, verify, commit (`feat: add admin entity picker and allowlist editor`).

---

### Task 18: Docker, compose, and README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `README.md`

**Dockerfile:** multi-stage on `node:24-alpine`. Builder runs `pnpm install --frozen-lockfile`, `pnpm build`. Runtime installs production deps only, copies `dist/`, runs as the existing non-root `node` user, declares `VOLUME /data`, exposes the port, and sets a `HEALTHCHECK` hitting a `GET /api/health` endpoint (add it in `app.ts` — unauthenticated, returning `{ok:true, haStale:boolean}`).

**compose:** binds the published port to a LAN interface with a comment explaining why `0.0.0.0` is wrong here, mounts `./data:/data`, and reads env from `.env`.

**README:** covers creating a **non-admin** HA user and its long-lived token (and why it must not be an admin or owner account); the env vars; first-run setup through the admin UI; the network isolation model; and the accepted risks from the spec.

- [ ] **Step 1: Write the health endpoint test** in `test/integration/routes-guest.test.ts` — `GET /api/health` returns 200 without a session and reports `haStale`.
- [ ] **Step 2: Run and verify failure.**
- [ ] **Step 3: Implement the endpoint, Dockerfile, compose file and README.**
- [ ] **Step 4: Verify** — `pnpm test && pnpm typecheck && docker build -t ha-guest-portal .`
- [ ] **Step 5: Commit** — `git commit -m "feat: add Docker packaging, compose file and setup documentation"`

---

### Task 19: End-to-end smoke test

**Files:**
- Create: `playwright.config.ts`, `test/e2e/portal.spec.ts`, `test/e2e/harness.ts`

**Interfaces:**
- Consumes: everything.

`harness.ts` starts a `FakeHomeAssistant`, seeds it, and boots the real built server against it on an ephemeral port with known passwords and a temp-file SQLite DB.

**The one path that matters:** log in as admin → open `/admin` → search the picker for `porch` → select `light.porch` → save → open `/` → the tile appears showing `off` → click it → assert the fake recorded a `light.turn_on` service call → `fake.setState('light.porch','on')` → assert the tile flips to on **without a page reload**.

Second path: `fake.drop()` → the tile shows the stale treatment within a few seconds.

**Third path — boot order.** Start the portal BEFORE the fake Home Assistant is listening, then bring HA up. Assert the portal subscribes and tiles populate without intervention. This is the real cold-start sequence under Docker Compose (portal ready in ~2s, HA in 30-60s) and the unit-level coverage exercises 'not yet started' rather than 'unreachable for a while, then appears'. Only an e2e run covers the genuine article.

This crosses cookie auth, the allowlist check, the REST action, the WS subscription, the compressed-diff application, the SSE fan-out and the React store. Unit tests pass on all seven while the wiring between them is broken.

- [ ] **Step 1: Write the spec file and config.**
- [ ] **Step 2: Run and verify it fails** — `pnpm test:e2e`
- [ ] **Step 3: Fix whatever integration bugs it exposes.** Do not weaken the test.
- [ ] **Step 4: Verify** — `pnpm typecheck && pnpm test && pnpm test:e2e` all green.
- [ ] **Step 5: Commit** — `git commit -m "test: add end-to-end portal smoke test"`

---

### Task 20: Home Assistant add-on packaging

**Files:**
- Create: `addon/config.yaml`, `addon/Dockerfile`, `addon/run.sh`, `addon/DOCS.md`, `repository.yaml`
- Modify: `README.md` (add-on install path alongside the Docker path)
- Test: `test/unit/addon-config.test.ts`

**Interfaces:**
- Consumes: Task 7's `HA_WS_URL` support; Task 18's build.
- Produces: no runtime code. The application is unchanged — this task adds packaging only.

**The governing constraint: one image, one code path.** The server reads
environment variables and must remain entirely unaware that add-ons exist. All
add-on specifics live in `run.sh`. If this task finds itself editing anything
under `src/`, something has gone wrong — stop and report it.

`addon/config.yaml` must set: `slug: ha_guest_portal`; `name`; `version` matching
`package.json`; `arch: [amd64, aarch64]`; `homeassistant_api: true` (this is what
makes the Supervisor inject `SUPERVISOR_TOKEN` and proxy the Core API);
`ports` publishing the portal port; `init: false`; and an `options`/`schema` pair
for `guest_password` (`password`), `admin_password` (`password`) and `port`
(`int`). Do **not** enable `ingress` — see below.

`addon/run.sh` reads the add-on options from `/data/options.json`, exports them
as the same environment variables the Docker target uses, and `exec`s the
server. The mapping is:

```
HA_BASE_URL   = http://supervisor/core
HA_WS_URL     = ws://supervisor/core/websocket
HA_TOKEN      = $SUPERVISOR_TOKEN
GUEST_PASSWORD, ADMIN_PASSWORD, PORT  ← from /data/options.json
DB_PATH       = /data/portal.db        (add-on /data is already persistent)
```

Parse `options.json` with `jq` (present in HA base images) or `node -e`; do not
hand-roll JSON parsing in shell. `exec` the server so it receives signals as PID 1.

**Ingress is deliberately disabled.** Ingress serves the add-on behind Home
Assistant's own authenticated session, which would require every guest to hold a
Home Assistant account — the exact thing this project exists to avoid. Add a
comment in `config.yaml` saying so, or a future maintainer will "helpfully"
enable it.

**Local add-on, no registry.** The user copies the repository into
`/addons/ha-guest-portal/` and installs from the add-on store's local section,
so `addon/Dockerfile` builds from source and `config.yaml` has no `image:` key.
This avoids requiring a container-registry account. `repository.yaml` supports
the custom-repository path for anyone who prefers it.

- [ ] **Step 1: Write the failing test**

`test/unit/addon-config.test.ts` parses `addon/config.yaml` and `addon/run.sh` as
text and asserts the contract that silently breaks otherwise: `homeassistant_api`
is `true`; `ingress` is absent or `false`; the `version` equals `package.json`'s;
every key in `options` has a matching entry in `schema`; `arch` includes `amd64`;
and `run.sh` sets all six environment variables listed above, with `HA_WS_URL`
pointing at `/core/websocket` (not `/api/websocket`) and `HA_TOKEN` derived from
`SUPERVISOR_TOKEN`. No YAML dependency is permitted — extract with a small regex
or `JSON.parse` of a `node -e` conversion, or assert on the raw text.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run test/unit/addon-config.test.ts`
Expected: FAIL — `addon/config.yaml` does not exist.

- [ ] **Step 3: Write the add-on files**

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`, then
`sh -n addon/run.sh` to syntax-check the shell script, and
`docker build -f addon/Dockerfile .` to confirm the add-on image builds.
Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add Home Assistant add-on packaging"
```

---

## Self-Review

**Spec coverage:** Problem/threat model → T2, T11, T18. Modules table → T1–T17 one-to-one. Security boundary → T2, T13. HA integration → T5–T10. Compressed format + trap → T5, T9. Failure behaviour → T7, T9, T12, T16. Data model → T4. Auth → T11, T13. HTTP API → T13, T14, T18 (health). SSE protocol → T12, T13. UI → T16, T17. Testing → T6 plus every task. Stack → T1. Configuration → T1. Deployment → T18. Accepted risk 2 (orphaned rows) → T14, T17.

**Placeholder scan:** none. Tasks 3, 4, 8, 9, 12, 14–17 compress steps 2–5 into one line because those steps are mechanical and identical in shape to Tasks 1 and 2; the test content and interfaces they need are fully specified.

**Type consistency:** `CatalogEntry`, `Device`, `AllowlistRow`, `Role`, `SseFrame` are defined once in `src/shared/api.ts` (T3) and referenced unchanged thereafter. `validateAction` (T2) is consumed only in T13. `Deps` (T13) is extended by T14 without redefinition. `StateChangeListener` (T9) is re-exported through `HaClient` (T10) with the same signature.
