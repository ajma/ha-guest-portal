# Multi-Portal Support — Design

**Date:** 2026-09-20
**Status:** Approved
**Builds on:** `2026-09-18-ha-guest-portal-design.md`, `2026-09-19-portal-toggle-and-integration-design.md`, `2026-09-20-single-page-portal-design.md`

## Problem

One deployment serves exactly one guest portal: one password, one device
allowlist, one theme, one title. A short-term rental with multiple guest
rooms, or a household with more than one recurring guest, has no way to give
each guest their own curated set of devices and their own password — they'd
all share one login and see every exposed device, shared-area or not.

## Goals

- More than one portal per deployment, each with its own password, title,
  theme, enablement, and device allowlist.
- Which portal a guest sees is determined entirely by which portal's password
  they entered — no other selection step.
- One admin identity (ingress, or an optional deployment-wide
  `ADMIN_PASSWORD`) can view, edit, and switch between every portal.
- A device can be exposed in more than one portal at once (e.g. a shared
  living room light visible to every guest, alongside devices only in their
  own room), each with independently configured allowed actions.
- The Home Assistant custom integration exposes one switch + one sensor
  **per portal**, added/removed automatically as portals are created/deleted.

## Non-goals

- Per-portal admin passwords. Admin access is one shared, deployment-wide
  credential (or ingress) that can reach every portal.
- Migrating existing single-portal installs. This project has not had an
  official release yet; this ships as a breaking schema change. **The SQLite
  database must be deleted before running a build with this change.**
  Migration tooling is only worth building once there's a real upgrade path
  to protect, i.e. after the first tagged release.
- Upgrading password storage to a salted/adaptive hash. Passwords keep
  today's scheme (SHA-256 + timing-safe compare, not hashed-at-rest) —
  consistent with the project's current risk tolerance, revisited separately
  if it ever needs to change.
- A way to preview a portal's theme from the (now theme-neutral) login
  screen before authenticating.
- Per-portal admin logout / per-portal deployment settings. Integration
  pairing info and logout are deployment-wide, reached the same way
  regardless of which portal is selected.

## Decisions taken

| Question | Decision |
|---|---|
| What identifies which portal a guest sees? | The password they log in with — each portal's password is unique across the deployment |
| Admin password scope | One optional, deployment-wide `ADMIN_PASSWORD`, unchanged in kind from today |
| First portal creation | Same UI as adding any later portal — zero portals is just "the add-portal screen is what's shown" |
| Duplicate password on create/change | Rejected with a validation error, checked against every other portal **and** `ADMIN_PASSWORD` |
| Password field UX | Masked by default, with a click-to-reveal toggle |
| Admin's currently-viewed portal | Persisted as a single deployment-level value, not tied to any one session |
| Can one entity belong to multiple portals? | Yes — portals like "Timothy's" and "Mary's" share common-area devices alongside room-specific ones |
| Portal deletion | Cascades its own devices/interaction/audit rows; deleting the last portal is allowed and drops back to the add-portal screen |
| Per-portal settings UI | An inline collapsed section between the portal header and the device grid — not a modal panel |
| Deployment-wide settings UI | A separate modal panel, opened by a gear icon, holding the HA integration pairing info and the admin's Logout button |
| Guest logout | Unchanged — guests keep their own standalone header button, untouched by any of the above |
| HA integration entity model | One config entry per deployment (unchanged Supervisor discovery); its coordinator dynamically creates one switch + one sensor per portal |
| Migration | None. Pre-release; database wipe required |

## Architecture

Unchanged at the top level: one Node/Hono process, one SQLite database, one
Home Assistant WebSocket connection, one custom-integration config entry per
deployment. What changes is that most of what used to be global singletons
becomes a per-portal row, joined against the one shared Home Assistant state
cache:

```
┌─ add-on container ────────────────────────────────────────────┐
│  one HA connection, one live state cache                      │
│           │                                                    │
│           ├─ portal "timothy" → allowlist → projected devices  │
│           ├─ portal "mary"    → allowlist → projected devices  │
│           └─ portal "..."     → allowlist → projected devices  │
│                                                                  │
│  SseHub: connections bound to a portalId, patches routed only  │
│  to portals whose allowlist includes the changed entity        │
└──────────────────────────────┬──────────────────────────────────┘
                                │ 10s poll, bearer token
                                ▼
                custom_components/ha_guest_portal
                  one config entry (deployment identity)
                  → N × (switch.<portal>, sensor.<portal>_last_interaction)
```

## Data model

```sql
CREATE TABLE IF NOT EXISTS portal (
  id       TEXT PRIMARY KEY,
  title    TEXT NOT NULL,
  theme    TEXT NOT NULL,
  password TEXT NOT NULL UNIQUE,
  enabled  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exposed_device (
  entity_id       TEXT NOT NULL,
  portal_id       TEXT NOT NULL REFERENCES portal(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  allowed_actions TEXT NOT NULL,
  sort_order      INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS guest_interaction (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  portal_id TEXT NOT NULL REFERENCES portal(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  entity_id TEXT,
  label     TEXT,
  action    TEXT,
  ok        INTEGER
);

-- Deployment-wide, unchanged in spirit from today's `settings` table, minus
-- the fields that moved into `portal`:
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- keys: 'deployment_id' (renamed from today's 'portal_id' — this identifies
--   the *deployment* for Supervisor discovery / HA device registry, and must
--   not be confused with a portal's own id), 'integration_token',
--   'last_selected_portal_id'
```

`exposed_device.entity_id` is no longer a primary key on its own — the
primary key is `(portal_id, entity_id)`, which is what makes one entity
addable to more than one portal.

`guest_interaction` loses today's `CHECK (id = 1)` singleton constraint and
becomes append-only per portal (mirroring `action_log`'s shape, since it's no
longer meaningful to keep only the single latest row once there are multiple
portals' worth of activity — the HA sensor for a given portal reads its own
portal's latest row).

## Auth & session model

Login (`POST /api/login`) resolution order:

1. Supervisor-sourced request (ingress) → admin session, unconditionally, as
   today.
2. Supplied password equals `ADMIN_PASSWORD` (if set) → admin session.
3. Supplied password matches some portal's `password` → guest session scoped
   to that portal.
4. No match → reject.

Session shapes:

```ts
type SessionData =
  | { role: 'admin'; expiresAt: number }
  | { role: 'guest'; portalId: string; expiresAt: number }
```

Guest routes (`/api/devices`, `/api/stream`, action calls) are unchanged in
shape — they resolve `portalId` from `session.portalId`. Admin calls to the
same endpoints add `?portalId=` (validated against the admin role), since one
admin session isn't bound to a single portal.

Password uniqueness is enforced at write time (create, or change) against
every other portal's password *and* `ADMIN_PASSWORD` — a portal password
that collided with the admin password would make that portal silently
unreachable as itself.

## HTTP API

New admin-only routes:

- `GET /api/admin/portals` — list `{ id, title, theme, enabled }[]`
- `POST /api/admin/portals` — create `{ title, password }`
- `PUT /api/admin/portals/:portalId` — update title/theme/enabled, and
  optionally password (omitted = unchanged)
- `DELETE /api/admin/portals/:portalId` — delete, cascading its devices,
  interactions, and audit rows
- `PUT /api/admin/portals/:portalId/allowlist` — same payload shape as
  today's `/api/admin/allowlist`, now portal-scoped
- `PUT /api/admin/last-selected-portal` — persists the admin's current
  dropdown selection

Unchanged, and deliberately not portal-scoped:

- `GET /api/admin/entities` — the Home Assistant entity catalog. All portals
  share one HA connection and choose from the same available entities; only
  the allowlist (which entities + actions are exposed) is per-portal.
- `GET/PUT` deployment settings (integration token) — unchanged shape, moved
  to the new global settings panel client-side, not re-scoped server-side.

## Realtime updates (SSE)

Still one Home Assistant WebSocket connection and one live state cache.
What's new: the "devices with live state" list becomes a per-portal
projection — that portal's `exposed_device` rows joined against the shared
cache — rather than one global list.

Every SSE connection is bound to a `portalId` (guest: from session; admin:
from `?portalId=`). On an HA entity state change, the hub resolves *which
portal(s)* currently allowlist that `entity_id` (an entity can resolve to
more than one, per the shared-device decision above) and pushes a patch only
to connections bound to those portals. Two guests in different portals never
see each other's updates, even for a device they both share.

## Web app UX

- **Create-portal screen**: title + password (masked, with a reveal toggle).
  One component, two entry points: shown as the entire page when zero
  portals exist yet, or reached via "+ Add portal" at the end of the portal
  dropdown otherwise. Creating a portal switches the admin's selection to it.
- **Admin header**: the title becomes a dropdown of every portal's title
  (current one selected), with "+ Add portal" trailing the list. Alongside
  it: the existing Edit button, and a gear icon.
- **Guest header**: unchanged — static title text, standalone Log out
  button, no Edit/gear/dropdown of any kind.
- **Per-portal settings**: an inline collapsed section between the header and
  the device grid, admin-only, expanding to show that portal's title, theme,
  enable/disable toggle, password (masked/reveal/change, same uniqueness
  validation as creation), and a Delete button gated behind a confirmation
  step (deletion is destructive and immediate).
- **Deployment settings**: the gear icon opens a modal panel — unlike the
  per-portal section, this one *is* a panel, since it's not scoped to
  whatever's in the main view — containing the HA integration pairing info
  (token, deployment id) and the admin's Logout button.
- **Login screen**: no session yet means no portal is known, so it renders
  with a neutral/default appearance rather than any specific portal's theme.
  Once logged in, a reload injects that portal's real theme, same mechanism
  as today.

## Home Assistant custom integration

Supervisor discovery is deployment-level, not portal-level, so the config
entry stays one-per-deployment — unchanged discovery flow, unchanged
`unique_id` (the renamed `deployment_id`). Its `DataUpdateCoordinator` fetches
the portal list from the add-on each poll and dynamically creates/removes one
`switch.<portal_slug>` + one `sensor.<portal_slug>_last_interaction` pair per
portal, the same pattern HA integrations use for a hub exposing one entity
set per child device. `entity.py`'s device-registry identifiers gain the
portal's own id alongside the deployment id, so each portal's entities group
under their own device in HA rather than all sharing one.

## Testing

Unit/integration coverage follows the existing project shape: `config.ts`
password-uniqueness validation, `auth.ts` login-resolution order (including
the admin-password/portal-password collision guard), the SSE hub's
per-portal patch routing (including the shared-entity fan-out case), and the
route layer's portal-scoping. Python side: extend the existing
`pytest-homeassistant-custom-component` harness to cover dynamic entity
creation/removal as the coordinator's portal list changes between polls.

## Accepted risks

- Portal passwords remain SHA-256-compared plaintext-at-rest, now living in
  the SQLite file instead of process env — a larger blast radius than
  today's one or two env-var secrets, accepted for this pass per the
  non-goals above.
- No migration path from the current single-portal schema; this is a
  breaking change requiring a database wipe, acceptable only because there
  has been no official release yet.
