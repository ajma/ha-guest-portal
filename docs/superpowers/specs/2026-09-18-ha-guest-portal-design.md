# HA Guest Portal — Design

**Date:** 2026-09-18
**Status:** Approved

## Problem

Home Assistant cannot issue a token scoped to a subset of entities. Long-lived
access tokens are bound to a user account and inherit that account's
permissions; the permission engine exists (`homeassistant/auth/permissions/`)
and is genuinely enforced, but policies attach to groups and only three groups
exist, hardcoded in `homeassistant/auth/const.py`:

```
GROUP_ID_ADMIN = "system-admin"
GROUP_ID_USER = "system-users"
GROUP_ID_READ_ONLY = "system-read-only"
```

`homeassistant/components/config/auth.py` can assign `group_ids` to a user but
provides no way to create a group. Custom groups with policies *are* loaded from
`.storage/auth` if hand-edited, but that is an unsupported edit to an internal
store.

Therefore **this application is the security boundary.** It holds a privileged
HA token server-side and exposes only a small, explicitly allowlisted set of
devices to a password-protected LAN web UI.

## Goals

- Expose a curated subset of HA devices to a phone-friendly web UI.
- Curate that subset through an admin UI with an HA-style entity picker
  (search by friendly name or entity ID; results show name + area).
- Reflect live device state, including changes originating in HA itself.
- Deploy as a single Docker container on the local network.

## Non-goals

- Remote/internet access. Network isolation is the primary control.
- HA entity types beyond on/off domains, `cover`, and `lock`.
- User accounts, registration, or per-user permissions. Two shared passwords.
- Scenes, scripts, climate, media players.

## Threat model

| Actor | Assumed capability | Mitigation |
|---|---|---|
| Internet | None — port not forwarded | Compose binds to a LAN interface, not `0.0.0.0` |
| LAN device, no password | Can reach the HTTP port | Shared password; rate-limited login |
| Guest with guest password | Full use of the guest UI | Server-side allowlist; cannot reach admin routes or enumerate HA |
| Guest attempting API abuse | Can craft arbitrary HTTP requests | No HA-shaped routes exist; entity + action validated against allowlist before any outbound call |

The HA token is never sent to a browser under any circumstance.

## Architecture

Single Node process serving a Vite-built SPA, a small JSON API, and an SSE
stream. It maintains one persistent WebSocket to Home Assistant.

```
Browser ──HTTP──> Hono ──> allowlist check ──REST──> HA  (actions)
        <──SSE─── hub  <── state cache <──WS────────  HA  (state)
                              ▲
                         SQLite (allowlist, audit log)
```

**Actions travel over REST; state travels over WebSocket.** These are separate
failure domains on purpose: while the socket is reconnecting, buttons still
actuate. A tile that shows stale state but still works beats a dead button.

### Modules

| Path | Responsibility |
|---|---|
| `src/shared/devices.ts` | `DOMAIN_ACTIONS` table; `validateAction()` — the security boundary |
| `src/shared/api.ts` | Zod schemas for every request/response shape |
| `src/server/config.ts` | Env parsing via Zod; fails fast at boot |
| `src/server/ha/schemas.ts` | Zod schemas for HA WebSocket frames |
| `src/server/ha/connection.ts` | Socket lifecycle: auth handshake, message-ID correlation, reconnect, liveness |
| `src/server/ha/catalog.ts` | Joins entity/device/area registries into a picker catalog |
| `src/server/ha/states.ts` | `subscribe_entities`, compressed-diff application, state cache, staleness |
| `src/server/ha/client.ts` | Public façade — the only module the HTTP layer imports |
| `src/server/store/db.ts` | `node:sqlite` open + schema init |
| `src/server/store/allowlist.ts` | Allowlist CRUD; emits change events |
| `src/server/store/auditlog.ts` | Append-only action log |
| `src/server/http/auth.ts` | Sessions, login, rate limiting |
| `src/server/http/sse.ts` | SSE fan-out hub |
| `src/server/http/routes-guest.ts` | `/api/devices`, `/api/devices/:entityId/:action`, `/api/stream` |
| `src/server/http/routes-admin.ts` | `/api/admin/entities`, `/api/admin/allowlist` |
| `src/web/store.ts` | `useSyncExternalStore` over the SSE stream |
| `test/fake-ha.ts` | Scriptable fake HA server (WS + REST) |

Nothing outside `src/server/ha/` knows Home Assistant speaks two protocols.

## The security boundary

```ts
export const DOMAIN_ACTIONS = {
  light:         ['turn_on', 'turn_off', 'toggle'],
  switch:        ['turn_on', 'turn_off', 'toggle'],
  fan:           ['turn_on', 'turn_off', 'toggle'],
  input_boolean: ['turn_on', 'turn_off', 'toggle'],
  cover:         ['open_cover', 'close_cover', 'stop_cover'],
  lock:          ['lock', 'unlock'],
} as const
```

Action names are identical to HA service names, so no mapping table can drift.

A request passes three gates before any outbound call:

1. `entityId` appears in the SQLite allowlist.
2. The domain — parsed from the entity ID prefix, **never accepted from the
   client** — permits the action per `DOMAIN_ACTIONS`.
3. The stored row's `allowed_actions` permits it (lets an admin expose
   `unlock` without `lock`, for instance).

Because the domain is derived from the entity ID, no request shape exists that
can aim a `lock.unlock` service call at an entity exposed only as a light.

## Home Assistant integration

All three registry list commands were verified to lack `@require_admin` — the
decorators sit only on mutating commands. A single **non-admin** HA user's token
suffices for both the picker and the control path.

| Purpose | Call |
|---|---|
| Entity catalog | WS `config/entity_registry/list` |
| Device areas | WS `config/device_registry/list` |
| Area names | WS `config/area_registry/list` |
| Live state | WS `subscribe_entities` with `entity_ids` filter |
| Actions | REST `POST /api/services/{domain}/{service}` |

Area resolution is `entity.area_id ?? device(entity.device_id).area_id` —
entities usually inherit their area from their device. Entries with
`disabled_by` or `hidden_by` set are excluded from the picker.

### Compressed state wire format

`subscribe_entities` sends an initial snapshot then deltas:

```json
{ "type":"event", "id":3, "event": {
    "a": { "light.porch": {"s":"on","a":{"brightness":255},"lc":1.0,"lu":1.0,"c":"01H"} },
    "c": { "light.porch": { "+": {"s":"off"}, "-": {"a":["brightness"]} } },
    "r": [ "light.removed" ]
}}
```

Keys: `s` state, `a` attributes, `c` context, `lc` last_changed, `lu`
last_updated; `+` additions, `-` removals.

> **Trap:** `"a"` means *added entities* at the event level but *attributes*
> inside a `"+"` diff. Same key, two meanings, one nesting level apart.

`lc` is omitted when only `lu` changed. `c` may be either a string (context ID)
or an object.

### Failure behaviour

- **Disconnect** → state cache marked stale; SSE clients receive `degraded`;
  tiles render unknown rather than a confident wrong value.
- **Reconnect** → registries and full state re-fetched, fresh snapshot
  broadcast. Deltas are never replayed across a gap.
- **Allowlist change** → `subscribe_entities` freezes its `entity_ids` filter at
  subscribe time, so the allowlist store emits a change event that forces an
  unsubscribe/resubscribe and a rebroadcast.

A garage tile confidently showing "closed" when the server has not heard from HA
in ten minutes is the failure mode this design exists to prevent.

## Data model

```sql
CREATE TABLE IF NOT EXISTS exposed_device (
  entity_id       TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  allowed_actions TEXT NOT NULL,              -- JSON array of action strings
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS action_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,                 -- epoch ms
  entity_id TEXT NOT NULL,
  action    TEXT NOT NULL,
  role      TEXT NOT NULL,                    -- 'guest' | 'admin'
  ok        INTEGER NOT NULL                  -- 0 | 1
);
```

`node:sqlite` is used with only the `prepare`/`run`/`get`/`all` subset, which has
been unchanged since Node 22.5. The module is Stability 1.2 (release candidate)
as of v25.7.0 and experimental on Node 24 LTS; this is accepted because the
alternative, `better-sqlite3`, is a native module requiring musl prebuilds or a
full `node-gyp` toolchain in Alpine.

The audit log justifies SQLite over a JSON file and doubles as a test oracle:
integration tests assert on `action_log` rows, verifying the decision the server
made rather than the call it happened to emit.

## Auth

- **No password hashing.** `GUEST_PASSWORD` and `ADMIN_PASSWORD` are plaintext
  env vars compared with `timingSafeEqual` over SHA-256 digests of both sides
  (equal length, no length leak). Hashing at rest is theatre when the plaintext
  lives in the same environment, and argon2 would pull a native module into an
  Alpine build.
- **In-memory sessions.** A random 32-byte ID in a `Map` with a 30-day sliding
  TTL, delivered as an httpOnly, `SameSite=Lax` cookie. Revocable, with no
  signing secret to mishandle. A container restart logs everyone out.
- **Rate limiting** on login only: per-IP from the *socket* address — never
  `X-Forwarded-For` unless `TRUST_PROXY` is explicitly configured — plus a
  global ceiling so IP spoofing cannot evade the per-IP limit.

Admin routes require `role === 'admin'`. The admin session is a superset of
guest.

## HTTP API

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/login` | — | `{password}` → sets cookie, returns `{role}` |
| POST | `/api/logout` | guest | Destroys session |
| GET | `/api/session` | — | `{role}` or 401 |
| GET | `/api/devices` | guest | Allowlisted devices + current state |
| POST | `/api/devices/:entityId/:action` | guest | Perform an action |
| GET | `/api/stream` | guest | SSE: `snapshot`, `patch`, `degraded` |
| GET | `/api/admin/entities` | admin | Full picker catalog |
| GET | `/api/admin/allowlist` | admin | Current allowlist |
| PUT | `/api/admin/allowlist` | admin | Replace allowlist |

No route accepts a free-form domain/service pair, and no route proxies to HA.

### SSE protocol

- On connect: `snapshot` with every allowlisted device and its current state.
- On change: `patch` with the changed devices only.
- On HA disconnect: `degraded` with `{stale: true}`.
- Heartbeat comment (`: ping`) every 25 seconds to defeat idle proxy timeouts.

## UI

**Guest** — phone-first tile grid. Toggle tiles for the on/off domains. Cover
tiles with open/stop/close and transitional `opening`/`closing` states. Lock
tiles rendered distinctly, with a confirmation step on `unlock` only.

**Admin** — the entity picker. A hand-written combobox (~120 lines, full
keyboard support and `aria-activedescendant`) rather than a library bent to fit
a two-line row; searches friendly name and entity ID, showing the area as a
subtitle.

Stale state renders as a visibly unknown tile, never as a plausible value.

## Testing

`test/fake-ha.ts` is the keystone — a real WebSocket server implementing the
auth handshake, registry lists, and scripted `subscribe_entities` emissions,
plus a REST endpoint for service calls, with `drop()` to simulate HA restarting.
Every interesting failure in this system lives at that seam.

- **Unit** — table-driven over every domain × action × in/out-of-allowlist
  combination. The security boundary gets exhaustive coverage.
- **Integration** — real HTTP against the fake HA, asserting SSE frames and
  `action_log` rows.
- **E2E** — one Playwright path: login → tile renders → toggle → fake HA emits a
  change → tile updates. It crosses cookie auth, the allowlist check, the HA
  call, the WS subscription, the SSE fan-out and the React store; unit tests
  pass on all six while the wiring between them is broken.

With no human code review in this project, machine-checkable gates are
load-bearing rather than supplementary: `tsc --noEmit` under strict settings,
Zod parsing at every trust boundary, and the e2e smoke test.

## Stack

Chosen for build-time reliability, not aesthetics: fewer dependencies mean less
API surface to misremember, and everything below fails loudly at build or test
time rather than silently at runtime.

| Layer | Choice |
|---|---|
| Runtime | Node 24 LTS |
| Language | TypeScript, ESM, `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| Server | Hono + `@hono/node-server` |
| Validation | Zod 4 |
| Database | `node:sqlite` |
| Frontend | React 19, no router (two screens behind a login gate) |
| Client state | `useSyncExternalStore` over an SSE-fed module store — no TanStack Query, since the server pushes truth and there is no staleness to cache |
| Styling | Tailwind 4 (CSS-first config) |
| Build | Vite (web), `tsc` (server) — no server bundler |
| Tests | Vitest, Playwright |
| Tooling | pnpm, Biome |
| Deploy | Multi-stage `node:24-alpine`, non-root, `/data` volume |

SSE is written against the raw Node response — headers, `data:` frames, a
25-second heartbeat, cleanup on close — rather than Hono's `streamSSE` helper,
whose documentation does not address the Node adapter. The most important data
path in the app should not rest on unverified framework behaviour.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `HA_BASE_URL` | yes | — | REST base, e.g. `http://192.168.1.10:8123` |
| `HA_WS_URL` | no | `${HA_BASE_URL}/api/websocket` (ws/wss) | Explicit WebSocket URL override |
| `HA_TOKEN` | yes | — | Long-lived token for a **non-admin** HA user |
| `GUEST_PASSWORD` | yes | — | Guest UI password |
| `ADMIN_PASSWORD` | yes | — | Admin UI password; must differ from guest |
| `PORT` | no | `8080` | Listen port |
| `DB_PATH` | no | `/data/portal.db` | SQLite file |
| `TRUST_PROXY` | no | unset | Set only when behind a reverse proxy |

Config is Zod-parsed at boot and the process exits on invalid input.

## Deployment

Two supported targets, **one image and one code path**. The application reads
its configuration from environment variables only and knows nothing about
Home Assistant add-ons; each target is a thin wrapper that supplies those
variables.

### Target A — plain Docker (amd64)

Multi-stage build on `node:24-alpine`, running non-root, with `/data` mounted
for SQLite. Compose binds the published port to a specific LAN interface
(`192.168.x.x:8080:8080`) rather than `0.0.0.0`, so the container is
unreachable from outside the network even if the router is later misconfigured.

Setup requires creating a dedicated **non-admin** Home Assistant user and
generating its long-lived access token; the README documents this, including why
the token must not belong to an admin or owner account.

> **mDNS does not resolve inside containers.** `http://homeassistant.local:8123`
> works from a browser and fails from Alpine, which has no mDNS resolver. The
> README leads with using a LAN IP, and `loadConfig` rejects a `.local` host with
> a message naming this cause rather than letting it surface as a generic
> connection timeout.

### Target B — Home Assistant add-on (HA OS / Supervised)

Add-ons require HA OS or HA Supervised; HA Container installs cannot use them.
Packaged as a **local add-on** built from source, so no container registry
account is required: the user copies the repository into `/addons/ha-guest-portal/`
and installs it from the add-on store's local section.

With `homeassistant_api: true`, the Supervisor injects `SUPERVISOR_TOKEN` and
proxies Home Assistant at `http://supervisor/core/api/` and
`ws://supervisor/core/websocket`. This removes both the long-lived token and the
mDNS/IP problem entirely. Note the WebSocket path differs from a direct HA
connection (`/core/websocket`, not `/api/websocket`) — hence the `HA_WS_URL`
override, which is the only accommodation the application itself needs.

`addon/run.sh` reads the add-on options from `/data/options.json` and exports
them as the same environment variables Target A uses, then execs the server.
The add-on's `/data` is already persistent, so the SQLite path is unchanged.

**Ingress is deliberately not used.** Ingress serves an add-on through Home
Assistant's own authenticated session, which would require every guest to hold a
Home Assistant account — the precise thing this project exists to avoid. The
add-on exposes a direct port and keeps its own password authentication.

The Supervisor token is not entity-scoped, so it confers no least-privilege
advantage over a dedicated non-admin user's token; this application remains the
security boundary under both targets.

## Accepted risks

1. Anyone holding the guest password can operate every exposed device,
   including locks. Chosen knowingly; mitigated by per-device `allowed_actions`
   and the confirmation step on `unlock`.
2. Renaming an entity in HA orphans its allowlist row. The admin UI flags rows
   whose entity ID is absent from the catalog rather than failing silently.
3. `node:sqlite` is pre-stable. Mitigated by using only its long-settled API
   subset.
4. A container restart ends all sessions. Accepted.
