# Portal Toggle and Home Assistant Integration — Design

**Date:** 2026-09-19
**Status:** Approved
**Builds on:** `2026-09-18-ha-guest-portal-design.md`

## Problem

The portal is always on. Between bookings, or when something looks wrong, there
is no way to stop guests reaching it short of stopping the add-on — which also
takes down the admin surface and drops the SQLite connection.

Separately, the portal is invisible from inside Home Assistant. An owner cannot
put its status on a dashboard, and cannot be notified when a guest uses it. The
data exists (`action_log` records every attempt) but never leaves the container.

## Goals

- An enable/disable toggle for the guest surface, operable from the add-on's
  admin UI and from Home Assistant.
- Expose that toggle to Home Assistant as a controllable entity, via a custom
  integration.
- Expose a timestamp entity reporting when a guest last interacted with the
  portal, shaped for both dashboard display and notification automations.
- Both halves work in the add-on deployment and the plain Docker deployment.

## Non-goals

- Scheduling, calendar integration, or automatic enable/disable. The toggle is
  manual; automate it from HA if you want a schedule.
- Per-guest or per-device disabling. One switch, whole guest surface.
- Exposing the allowlist to Home Assistant for editing.
- Surfacing full interaction history from the portal. HA's recorder already
  keeps the history of any entity's state changes.
- MQTT discovery as an alternative transport.

## Decisions taken

| Question | Decision |
|---|---|
| What does "disabled" mean? | Guests blocked, admin surface unaffected |
| How does the integration connect? | Supervisor discovery, with a manual config-flow fallback |
| What counts as an interaction? | Guest actions **and** guest logins, in one sensor |
| Update latency | ~10s polling via `DataUpdateCoordinator` |
| Integration credential | A dedicated bearer token scoped to two routes |
| Python test depth | Full `pytest-homeassistant-custom-component` harness |

## Architecture

Two deployment units that share no memory and meet only over HTTP:

```
┌─ add-on container ──────────────┐      ┌─ HA core process ──────────────┐
│  Node/Hono portal               │      │  custom_components/            │
│    settings.portal_enabled ◄────┼──────┼──  ha_guest_portal             │
│    guest_interaction (1 row) ───┼──────┼─►    switch.guest_portal       │
│    /api/integration/*  (bearer) │ 10s  │      sensor...last_interaction │
└────────────┬────────────────────┘ poll └────────────────────────────────┘
             │ POST /discovery (once, at startup)
             ▼
        Supervisor ──► config flow on ha_guest_portal
```

**The toggle's truth lives in the add-on's SQLite**, not in Home Assistant. The
portal's enablement must not depend on HA being reachable, and must never fail
open because an integration was removed. The HA switch is a remote control, not
the source of truth.

## Data model

Two new tables. `action_log` and `exposed_device` are unchanged.

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guest_interaction (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  ts        INTEGER NOT NULL,
  kind      TEXT    NOT NULL,   -- 'action' | 'login'
  entity_id TEXT,               -- NULL when kind = 'login'
  label     TEXT,               -- NULL when kind = 'login'
  action    TEXT,               -- NULL when kind = 'login'
  ok        INTEGER NOT NULL
);
```

`settings` keys, all created on first start if absent:

| Key | Value |
|---|---|
| `portal_enabled` | `'1'` \| `'0'`, default `'1'` |
| `integration_token` | 32 random bytes, hex |
| `portal_id` | UUID; the portal's stable identity across reconfigurations |

`guest_interaction` holds one row, upserted on `id = 1`.

**Why a single row rather than a log.** Home Assistant's recorder keeps the
state history of the sensor, so a second history in the portal would be
redundant. It is persisted rather than held in memory so the sensor does not
blank to `unknown` on every add-on restart.

**Why not extend `action_log`.** `action_log` is a security artifact — every
action attempt, including ones rejected before reaching HA. Login rows have no
entity or action, so reusing it means relaxing its `NOT NULL` columns (a table
rebuild in SQLite) and weakening a record whose value is its strictness.

`label` is snapshotted from the allowlist at write time, so a notification still
reads "Front Door" after that device has been removed from the allowlist.

## The kill-switch

### Enforcement

All gates key on `role === 'guest'`. Nothing with `role === 'admin'`, and no
ingress traffic, is affected.

| Point | Behaviour when disabled |
|---|---|
| `POST /api/login` | Correct guest password → `403 {error:'portal_disabled'}`, and **`limiter.recordFailure()` is not called** |
| `GET /api/session` | Still answers; response gains `portalEnabled` |
| `GET /api/devices` | `403 {error:'portal_disabled'}` |
| `POST /api/devices/:entityId/:action` | `403 {error:'portal_disabled'}` |
| `GET /api/stream` | `403` on connect; open guest streams closed at the moment of disabling |
| `/api/admin/*` | Unaffected |
| `/api/integration/*` | Unaffected (that is how it gets re-enabled) |

The rate-limiter exemption is load-bearing. The password was correct; counting
it as a failure would let a disabled portal lock out a guest who keeps trying,
and they would then stay locked out after re-enabling.

### Blocking, not invalidation

Disabling does not destroy guest sessions. The session cookie stays valid, so
re-enabling restores access without the guest re-entering the password. The
disabled screen re-polls `GET /api/session` every 15 seconds, so an open guest
tab recovers unaided.

### Propagation

The SSE discriminated union gains a fourth frame:

```ts
const PortalFrameSchema = z.object({
  type: z.literal('portal'),
  enabled: z.boolean(),
})
```

Broadcast to every connected client on change. This serves guest clients
(who maintain an SSE connection). Guest streams are then closed. The close is
belt-and-braces: if the frame is missed, the client's existing stream-drop
recheck hits `/api/session`, reads `portalEnabled: false`, and renders the
disabled screen by the same path.

The admin surface does not maintain an SSE connection — it refreshes its
toggle state when the window regains focus rather than by live push.

This requires `SseHub` to track a `Role` per connection, which it does not
currently do. `hub.add(res)` becomes `hub.add(res, role)`, and the hub gains
`closeRole(role)`.

### Admin UI

A new section above "Add Entity" in `Admin.tsx`:

- A toggle showing current state, which **takes effect on click**. It is
  deliberately not wired into the allowlist's dirty/Save flow — a kill-switch
  that needs a second click to take effect is a defect.
- A visible banner when disabled, so the state is never ambiguous.
- A collapsed "Integration token" row with a copy button, for manual setup of
  the integration in non-add-on deployments.

## HTTP API

### New admin routes (session or ingress, admin role)

```
GET /api/admin/portal
    → { enabled, integrationToken, portalId }

PUT /api/admin/portal          { enabled: boolean }
    → { enabled }
```

### New integration routes (bearer token only)

Mounted in `src/server/http/routes-integration.ts`. No cookie path, no session.
The token is compared in constant time using the helper in `http/auth.ts`.

```
GET /api/integration/state
    → { portalId, enabled, haStale, deviceCount, version,
        lastInteraction: {
          ts, kind, entityId, label, action, ok
        } | null }

    haStale     — the existing WebSocket-to-HA staleness flag
    deviceCount — number of allowlisted devices
    Both are surfaced as attributes on the switch entity.

POST /api/integration/enabled  { enabled: boolean }
    → { enabled }
```

Missing or malformed credentials return `401`; a wrong token returns `401`.
These are the only two routes the token opens. It cannot read or write the
allowlist, cannot read the audit log, and cannot log in.

**These routes are reachable on the LAN-facing port.** That is deliberate: the
plain Docker deployment has no Supervisor network, so there is no internal-only
path available. A 256-bit bearer secret is a stronger gate than the guest
password already served on that port.

## Supervisor discovery

`src/server/hassio/discovery.ts`, active only when `SUPERVISOR_TOKEN` is set.
On startup:

1. `GET http://supervisor/addons/self/info` → the add-on's internal `hostname`
   and `version`.
2. `GET http://supervisor/discovery` → delete any existing record for this
   add-on and service, so a restart replaces rather than duplicates.
3. `POST http://supervisor/discovery` with:

```json
{
  "service": "ha_guest_portal",
  "config": { "portalId": "...", "host": "...", "port": 8080, "token": "..." }
}
```

All three steps log and swallow failures. The portal must start even if the
Supervisor refuses discovery.

`config.yaml` gains one key and no new privileges:

```yaml
discovery:
  - ha_guest_portal
```

`/discovery*` is on the Supervisor's list of endpoints callable without
`hassio_api: true`. Supervisor's `discovery/validate.py` types `service` as a
bare `str` with no allowlist, and HA core's `hassio/discovery.py` passes it
straight to `discovery_flow.async_create_flow()` as the target domain — so a
custom integration domain is a valid discovery service. HA re-fetches the record
from the Supervisor by UUID rather than trusting the POST body, which makes this
a safe channel for the token.

## The integration

`custom_components/ha_guest_portal/`. `iot_class: local_polling`,
`config_flow: true`, empty `requirements` — it uses HA's own `aiohttp` session
via `async_get_clientsession`.

| File | Responsibility |
|---|---|
| `const.py` | `DOMAIN`, default port, `SCAN_INTERVAL = 10s` |
| `api.py` | Async client over the two routes. Raises `PortalAuthError` / `PortalConnectionError`; nothing above it touches HTTP |
| `coordinator.py` | `DataUpdateCoordinator[PortalState]`, one fetch feeding both entities |
| `config_flow.py` | `async_step_user`, `async_step_hassio`, `async_step_reauth` |
| `__init__.py` | Entry setup/unload, platform forwarding |
| `switch.py` | `switch.guest_portal` |
| `sensor.py` | `sensor.guest_portal_last_interaction` |
| `strings.json`, `translations/en.json` | Flow and entity strings |

### Config flow

- **`async_step_user`** — form for host, port, token. Validated by a live call
  to `GET /api/integration/state` before the entry is created.
- **`async_step_hassio`** — reads `HassioServiceInfo.config`, sets the entry's
  `unique_id`, and shows a confirmation card.
- **`async_step_reauth`** — triggered by `PortalAuthError`, re-prompts for the
  token only.

The entry's `unique_id` is `portalId` in both paths. A portal added manually and
then discovered aborts with `already_configured` rather than producing duplicate
`switch.guest_portal_2` entities.

### Entities

Both attach to one device registry entry, "Guest Portal", identified by
`(DOMAIN, portal_id)`.

**`switch.guest_portal`** — `is_on` from the coordinator. `async_turn_on` /
`async_turn_off` call `POST /api/integration/enabled`, update local state
optimistically, then `async_request_refresh()`. Without the optimistic update
the toggle visibly springs back for up to 10 seconds.

It carries `device_count` and `ha_link_stale` as attributes, which is what the
corresponding fields in the state response exist for — a dashboard card can then
show "on, 4 devices, link healthy" without a second entity.

**`sensor.guest_portal_last_interaction`** — `device_class: timestamp`; native
value is the UTC datetime of `lastInteraction.ts`, or `None` before any
interaction. A timestamp device class renders as a live "3 minutes ago" on a
dashboard with no template. Attributes are uniform across both kinds:

```yaml
kind: action                        # or 'login'
target_entity_id: lock.front_door   # null when kind == 'login'
label: Front Door                   # null when kind == 'login'
action: unlock                      # null when kind == 'login'
ok: true
```

The attribute is `target_entity_id`, not `entity_id`: Home Assistant treats a
bare `entity_id` attribute as a membership list (that is how groups work), and
reusing the name on an unrelated sensor invites both confusion and tooling that
misreads it.

A notification automation is therefore a state trigger on the sensor, optionally
narrowed with `state_attr('sensor.guest_portal_last_interaction','kind')`.

Both entities report `unavailable` when the coordinator cannot reach the portal,
rather than a stale `off`.

### Version compatibility

`GET /api/integration/state` returns the portal's version. If the field is
absent or below the integration's minimum, the integration raises a repair issue
("update the Guest Portal add-on") instead of failing on a missing key.

## Interaction recording

Written in `routes-guest.ts`, scoped to `role === 'guest'`:

- successful guest login → `{kind: 'login', ok: true}`
- every guest action attempt → `{kind: 'action', entityId, label, action, ok}`,
  including allowlist rejections and Home Assistant failures

Admin-role actions do not move the sensor, even when performed through the guest
view on the direct port. It is a guest-activity signal.

## Repository layout

```
config.yaml              # gains  discovery: [ha_guest_portal]
repository.yaml
hacs.json                # NEW — HACS manifest
brand/icon.png           # NEW — required by HACS
custom_components/
  ha_guest_portal/       # NEW
src/ test/ Dockerfile    # unchanged
```

`.dockerignore` gains `custom_components`, `brand`, `hacs.json`. The image must
not carry Python it never runs — the two halves are separate containers that
meet only over HTTP, and shipping one inside the other invites confusion.

`biome.json` ignores `custom_components/**`, so Biome does not reformat
`manifest.json` into a shape hassfest rejects.

`config.yaml:version` and `manifest.json:version` move independently.

**Out of scope, flagged:** the repository root carries both `repository.yaml`
(GitHub add-on repository layout) and `config.yaml` (local `/addons/<name>/`
layout). This predates the change and is untouched here.

## Testing

### TypeScript (vitest, existing setup)

`test/fake-supervisor.ts` joins the existing `test/fake-ha.ts`.

Unit:
- `SettingsStore` — defaults, persistence, `onChange`
- interaction store — upsert semantics, null columns for `kind: 'login'`
- token generation and constant-time comparison
- the `portal` SSE frame schema

Integration:
- guest login with the **correct** password while disabled → 403, and the rate
  limiter is not incremented
- `/api/devices`, the action route, and `/api/stream` refuse guests while
  disabled
- admin routes and ingress-sourced requests are unaffected while disabled
- `/api/integration/*` with valid, invalid, and absent bearer tokens
- an interaction is recorded for guest login, guest action, and *rejected* guest
  action — and **not** for an admin action
- discovery module against the fake Supervisor: publish, replace-on-restart,
  and start-anyway-on-failure

E2E (playwright):
- toggle off in the admin tab → the guest tab reaches the disabled screen;
  toggle on → it recovers without intervention

### Python (pytest)

`pytest` + `pytest-homeassistant-custom-component`, `ruff` for lint, `uv` for
the environment. Covering:

- `config_flow`: manual setup, discovery setup, duplicate prevention across both
  paths, invalid token, unreachable host, reauth
- `coordinator`: failure marks entities unavailable; recovery restores them
- `switch`: optimistic update, API failure path
- `sensor`: timestamp conversion, attribute shape for both kinds, `None` before
  any interaction

Plus `hassfest` and the HACS validation action for manifest and structure.

## Documentation

- `README.md` — integration installation (HACS and manual), and the toggle
- `DOCS.md` — the toggle in the add-on admin UI
- `DECISIONS.md` — four new entries:
  - why the toggle's truth is in SQLite rather than Home Assistant
  - why `action_log` was left alone in favour of a one-row table
  - why the integration token is scoped to two routes rather than reusing the
    admin password or a session
  - why the integration routes are served on the LAN-facing port

## Accepted risks

- The integration token is stored in HA's config entry store and, in the add-on
  deployment, in the Supervisor's discovery record. Anyone with access to either
  can toggle the portal. They cannot edit the allowlist or read the audit log.
- Up to ~10 seconds of latency between a guest interaction and the HA sensor
  updating. Accepted in exchange for a standard polling coordinator.
- A guest mid-action when the portal is disabled may see a generic error rather
  than the disabled screen, until their next request or the 15s re-poll.
- Only the most recent interaction is retained by the portal. If HA's recorder
  is disabled or purged, that history is not recoverable from the add-on.
- Rotating `integration_token` (by clearing the settings row) silently breaks an
  existing config entry until reauth is completed. There is no rotation UI.
