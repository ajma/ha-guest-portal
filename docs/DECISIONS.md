# Decisions

Why this project is shaped the way it is. Each entry records a decision that is not
obvious from the code, and what it would cost to reverse.

## Architecture

**Actions go over REST; state comes over WebSocket.** Deliberately separate failure
domains. While the socket is reconnecting, buttons still actuate. A tile that shows
stale state but still works beats a dead button. Several fixes exist purely to preserve
this property end to end, including keeping guest controls enabled when state is stale.

**SSE bypasses Hono entirely.** `/api/stream` is handled by the raw `node:http` server;
everything else is delegated to Hono via `getRequestListener`. Hono's `streamSSE` helper
has undocumented behaviour under its Node adapter, and this is the application's most
important data path — it should not rest on unverified framework behaviour. Cost: one
endpoint has a hand-written session check (sharing the same helper as the middleware).

**All composition lives in `createRuntime(deps)`, not in `main()`.** `index.ts` is thin.
This exists so the wiring — the highest-risk code in the project — is importable and
testable. When it lived inline in `main()`, the test suite built a parallel server and
the real wiring had no coverage at all.

**`HaConnection` re-establishes its own subscriptions on reconnect.** Consumers do not
have to remember. Home Assistant's `subscribe_entities` freezes its entity filter at
subscribe time, so a reconnect without re-subscription leaves the portal reporting
"connected" while delivering nothing.

**`StateCache` starts stale and only clears on a genuine full snapshot.** A mixed frame
containing both added and changed entities does not clear staleness, because entities
that vanished during the outage have not been reconciled. The portal must never render a
confident value it cannot vouch for — that is the reason this application exists in this
shape.

## Security

**This application is the security boundary.** Home Assistant cannot issue a token scoped
to specific entities: its permission engine attaches policies to groups, and only three
groups exist, hardcoded. So the portal holds a privileged token server-side and enforces
its own allowlist. `validateAction` in `src/shared/devices.ts` is that boundary — four
gates, with the domain derived from the entity ID and never accepted from the client.

**`not_allowlisted` returns 404, every other validation failure returns 403.** A 403
would confirm that an entity exists but is unexposed, letting a guest enumerate the
installation.

**Every action attempt writes an `action_log` row**, including ones rejected before
reaching Home Assistant. An attacker probing the boundary leaves a trace.

**`X-Forwarded-For` is ignored unless `TRUST_PROXY` is set, and then the rightmost hop is
used.** A proxy appends the address it saw, so the leftmost entry is attacker-supplied.
Taking it would let anyone evade per-IP rate limiting by varying a header. Assumes exactly
one trusted proxy hop, which matches this deployment.

**No password hashing at rest.** The plaintext is in the same environment as any hash
would be, so hashing is theatre. Effort went into constant-time comparison and rate
limiting instead. Note that `docker inspect` exposes the token and both passwords to
anyone with Docker daemon access — treat host access as full access.

**Sessions are in-memory.** A container restart logs everyone out. Accepted and intended;
it also means the app must return to the login screen when a session disappears, which it
does via a 401 hook plus a stream-drop recheck.

## Deployment

**One image, one code path.** The server reads configuration from environment variables
and knows nothing about Home Assistant add-ons. The add-on's `run.sh` translates
`/data/options.json` into the same variables the Docker target uses.

**The add-on runtime is `node:24-alpine`, not a Home Assistant base image.** The HA base
images supply bashio, s6-overlay and an init system, none of which this add-on uses. What
they cannot supply is Node 24 — `apk add nodejs` yields Node 18–22 depending on the base,
and `node:sqlite` (the allowlist and audit log) does not exist before Node 22.5. An add-on
is just a container the Supervisor manages; nothing requires it to descend from that base.

**Ingress is deliberately not used.** Ingress serves an add-on through Home Assistant's own
authenticated session, which would require every guest to hold a Home Assistant account —
the exact thing this project exists to avoid. The add-on exposes a direct port and keeps
its own password authentication.

**Compose uses a named volume, not a bind mount.** A `chown` in a Dockerfile has no effect
on a bind-mounted path — Docker replaces the directory with the host's, ownership included
— so a bind mount fails with `unable to open database file` for any host user whose uid is
not 1000. A named volume is seeded from the image and works everywhere. A bind mount is
documented as an opt-in requiring `chown 1000:1000 ./data`.

**Compose binds a specific LAN interface, not `0.0.0.0`.** The service has no transport
security and must not become reachable from outside the network if the router is later
misconfigured. `docker compose up` fails until the placeholder IP is replaced; that is
intentional.

**`.local` hostnames are rejected at config load.** mDNS does not resolve inside
containers, so `homeassistant.local` works from a browser and fails from the container.
The guard turns the most likely first-run failure into a named error rather than a
connection timeout.

**The healthcheck reports the process, not Home Assistant.** It returns 200 with
`haStale: true` when HA is unreachable. Marking the container unhealthy would make Docker
restart it, which fixes nothing and drops every guest's session.

## Dependencies

**`@types/node` is pinned to the `^24` line rather than latest.** The runtime target is
Node 24 LTS, and the 26.x typings describe `node:sqlite` APIs absent from Node 24.
Typechecking against APIs the runtime lacks is the silent-failure class this project's
verification strategy exists to prevent.

**Only the `prepare`/`run`/`get`/`all` subset of `node:sqlite` is used.** The module is
pre-stable; that subset has been unchanged since Node 22.5. `better-sqlite3` was rejected
because a native module needs musl prebuilds or a full toolchain in Alpine.

## Known accepted risks

- Anyone with the guest password can operate every exposed device, including locks.
  Mitigated by per-device `allowedActions` and a confirmation step on unlock.
- Renaming an entity in Home Assistant orphans its allowlist row. The admin UI flags
  orphaned rows rather than failing silently.
- The rate limiter uses fixed windows, so 120 attempts are possible across a window
  boundary (60 in each of two windows — the intended total; only the instantaneous rate
  doubles).
- A hand-edited non-0/1 `ok` value in `action_log` reads back as `false`. Requires direct
  database tampering and fails in the safe direction.
