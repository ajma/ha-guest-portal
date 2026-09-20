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

## Themes

**The theme is injected into the HTML, not fetched.** The server writes
`<html data-theme="…">` into the `index.html` it already rewrites for the ingress base
path, so the CSS variable block keyed off `[data-theme]` applies during parse, before
React loads. There is no unthemed flash and no endpoint to authenticate. Reversing means
accepting a flash of the wrong theme, or reintroducing a route that a guest can reach
before logging in.

**Component overrides are optional.** A theme supplying only tokens and an icon resolver
renders through the default component set; that is what keeps a new theme to one folder
rather than a component library. It is enforced by a test built on a synthetic
tokens-only theme, because all three shipped themes override every slot and so would not
exercise the guarantee at all. Reversal cost: the default set becomes dead code and every
future theme owes six components.

**The token set is closed — 25 tokens, every theme supplies all of them.** A theme needing
a value outside the list extends the list for everyone; private tokens would silently
break the default set's ability to render an arbitrary theme, which is the property the
entry above depends on. The set began at 15 and grew mid-implementation, when making
`classic` faithful to Home Assistant's tile card required nine per-state colour roles plus
a neutral control fill. Widening the set is the intended way to add a value, and it costs
an edit to every theme — which is the point: the cost is what stops the contract drifting
into a per-theme grab bag.

**Preview images are Playwright snapshot baselines, at deliberately tight tolerances.**
A theme's appearance changing fails the test until the snapshot is regenerated, which
regenerates the preview; with no CI here, "auto-captured" would otherwise mean "captured
when remembered". At Playwright's defaults that guarantee did not actually hold:
`threshold` is a per-pixel perceptual distance defaulting to 0.2 and `maxDiffPixelRatio`
was 0.02, while the icon circle carrying a tile's state colour is only about 0.6% of the
420x380 frame — repainting it from green to purple still passed. The tolerances are now
0.1 and 0.001 precisely because the baseline doubles as the admin picker's thumbnail: a
preview that cannot fail is one that silently stops matching the theme it advertises.
Reversal cost: loosening them again re-hides colour-only regressions.

**Themes are named neutrally.** `tiles`, `cards` and `classic`, rather than the products
they evoke. The add-on is distributed publicly, and naming a theme after a protected mark
while imitating its trade dress is exposure with no engineering benefit. Documentation may
say "inspired by"; identifiers may not.

**Home Assistant colours a tile by domain and state, not from one accent.** `classic`
reproduces that — amber lights, cyan fans, purple covers, green for a locked door and red
for an unlocked one — which is why the token set carries nine per-state colour roles
instead of a single `accent`. The values are taken from `home-assistant/frontend`'s own
`src/resources/theme/color/color.globals.ts`, and the mapping lives in
`src/web/themes/stateColor.ts` beside the contract rather than inside `classic`, because
`tiles` and `cards` colour by state too. Reversal cost: collapsing to one accent makes a
lit lamp and a locked door indistinguishable in every theme at once.

**Feature buttons stay neutral.** Home Assistant's `card-feature-styles.ts` hands
`ha-control-button` a radius and `--control-button-focus-color` and nothing else, so the
button's background keeps its `--disabled-color` default and the state colour reaches it
only as a focus ring. `classic` matches that, via a `controlNeutral` token. The honest
cost: this loses red-for-Unlock, and a red Unlock is a real affordance in a guest portal,
where the person pressing the button is not the homeowner and has no prior model of the
house. It was chosen to match Home Assistant on an explicit instruction to do so, and it
is a reasonable thing to revisit — reversing it is one fill in one component.

**`cards` fills its badge tonally rather than solidly.** Measured against the theme's own
palette: `--accentText` on a solid light-mode amber badge is 1.93:1, and no token in the
closed set is legible across all nine state fills in both directions — `--accentText`
fails on the amber and the cyan, `--text` fails on the purple and the red. Mixing the
state colour 40% into `--surface` keeps the badge's luminance near the card's, so `--text`
stays legible at 8.1:1 worst case in light mode and 4.3:1 in dark, while the hue still
says which device is doing what. The colour still comes from `stateColorToken()`, so the
theme has not opted out of the state palette — only out of painting it at full strength.

**Nothing keeps a second list of themes.** Adding a theme is one folder plus one registry
line, and the two places that could have become a second registry do not maintain a list
at all: the admin picker discovers previews by globbing the captured images, and the CSS
generator discovers themes by directory listing, cross-checked against `THEME_IDS`. This
is a correction, not a precaution — a hand-written preview map existed and did drift.
`tiles` shipped a committed preview while the picker still rendered "No preview captured"
beside it, with nothing failing, because the test asserted `classic` by name. Making the
file the registration removes the class of bug rather than the instance.

**The CSS generator reads each theme's tokens, not the registry.** Importing the registry
pulled in every theme's components, so a theme using any Vite-only import (`?raw`, `?url`,
an asset) broke `pnpm themes:css` under plain Node — with the error pointing at the
generator rather than at the import. That was an invisible constraint on what a theme may
contain, which the contract never meant to impose; it cost `cards` its icon imports.
A theme's `tokens.ts` is pure data behind a type-only import, so it loads anywhere.

**The Shell contract gained a `headerActions` slot, guarded by a contract test that
iterates every registered theme.** The slot carries the owner's Edit and Settings
buttons, and a theme that accepts the prop and silently drops it locks an owner out of
their own settings — with no other visible symptom, because the portal still renders
perfectly for everyone including that owner. No other test would notice, so
`test/unit/shell-contract.test.tsx` renders each registered theme's Shell with a sentinel
button and a known title and asserts both appear, with a non-empty guard on the list so an
empty registry cannot satisfy the loop vacuously. Reversal cost: none worth taking —
deleting the test restores a failure mode whose only report is a support question.

**Owner surfaces read theme tokens but are not theme components.** The tile editor,
entity picker, settings panel and title field take their colours, radius and font from
the CSS variables, so they adopt every theme's palette — dark mode and future themes
included — while adding no slot to `Theme['components']`. A theme is still one folder
plus one registry line. This reverses the themes plan's instruction to leave the admin
surface unthemed, which was right for a separate page and wrong for a panel that opens
over a themed grid. Reversal cost: hex literals return, and the panels look pasted onto
whichever themes they were not designed against.

## The portal page

**Owners edit the portal itself; there is no admin page.** You cannot tell what you are
shipping from a screen that looks nothing like it — the old `Admin.tsx` listed devices as
rows of form controls while guests got a themed grid, and it carried its own header, list,
layout and save model to do it. Role now feeds exactly one decision: whether the Shell is
handed `headerActions`. Reversing means reintroducing a whole surface that duplicates the
themed grid.

**Edits save immediately; there is no Save button.** The page holds a live SSE stream, so
batching edits locally would mean reconciling every incoming snapshot against uncommitted
local changes. Writing on every mutation keeps the stream authoritative: `useAllowlistEditor`
holds an optimistic overlay only while a request is in flight and drops it in a `finally`,
so the grid converges on what the server actually stored. The cost is that there is no undo,
which is why removal — the one destructive edit — asks for confirmation inline.

**A device added from the picker starts with no allowed actions.** It appears to guests
immediately, as an inert tile that can do nothing until the owner ticks the actions to
allow: a light, switch, fan or `input_boolean` says "No actions available" in so many
words, while a lock or cover simply renders with no buttons at all. Adding a lock therefore
cannot make it openable before it has been configured. The alternative, a persisted hidden
flag, adds a column and a whole visibility concept to the data model to solve what is
really a cosmetic problem. One consequence was not anticipated: an inert tile has nothing
focusable in it, so edit mode needs an explicit per-tile Edit button for keyboard parity —
intercepting the tap alone is not enough.

**Reordering uses arrows, not drag, and the arrows stay available for a device the portal
cannot actuate.** Drag is the most fragile part of this on touch and the hardest to make
accessible; Move up and Move down work with a keyboard and a screen reader, and adding drag
later is a pure enhancement with no data implications. An entity whose domain the portal
cannot operate still keeps its arrows, because position is domain-independent — the owner
may want to move it precisely *because* it is inert. Only the action checkboxes disappear
for such a device.

**The portal title is injected into the HTML, not fetched.** Same mechanism and the same
reasoning as the theme: the server writes `data-portal-title` and `<title>` in the pass
that already rewrites the document, so the header is right on first paint and no public
endpoint exists purely to serve one string to guests. The settings field additionally
reads `GET /api/admin/portal` when it opens, so an owner sees a rename made from another
session rather than the value their own page was loaded with. It is owner-supplied text
written into HTML, so it is escaped at the injection point and tested with a hostile value
— and both replacements take a function replacer, because `String.prototype.replace`
expands `$&` and `` $` `` in a string replacement and HTML-escaping does not defuse them.
Clearing the field stores the default `Guest Portal` rather than a blank, decided in
`normalizePortalTitle` and applied on read as well as write.

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

## Deployment

**One image, one code path.** The server reads configuration from environment variables
and knows nothing about Home Assistant add-ons. The add-on's `run.sh` translates
`/data/options.json` into the same variables the Docker target uses.

**The add-on runtime is `node:24-alpine`, not a Home Assistant base image.** The HA base
images supply bashio, s6-overlay and an init system, none of which this add-on uses. What
they cannot supply is Node 24 — `apk add nodejs` yields Node 18–22 depending on the base,
and `node:sqlite` (the allowlist and audit log) does not exist before Node 22.5. An add-on
is just a container the Supervisor manages; nothing requires it to descend from that base.

**Ingress is enabled for the admin surface only.** Ingress requests are authenticated by
Home Assistant before they reach the add-on and arrive only from the Supervisor at
`172.30.32.2`, so a guest without a Home Assistant account has no route in — ingress alone
would defeat the point. The add-on therefore listens on two ports: the ingress port (admin,
no password, Supervisor-only) and the published port (guests, portal password). The
source-address check on the ingress listener uses the raw socket address and never a
header, because that listener grants admin without a password.

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

**The default port is 9123, not 8080.** The UniFi Network Application add-on publishes
`8080/tcp: 8080` to the host, and qBittorrent also declares 8080, making 8080 the most
contended port in the Home Assistant add-on ecosystem. 9123 is clear of every port found
across the official and community add-on repositories, sits outside Linux's ephemeral
range (32768–60999) so the kernel cannot transiently hold it, and is mnemonically tied to
Home Assistant's own 8123 — which matters because it is a number a host reads out to a
guest. Reversal cost: changing it again moves existing users and invalidates documented
setup instructions.

**The add-on's `port` option was removed rather than fixed.** `config.yaml`'s `ports:`
mapping is static and cannot be templated from an option, so an in-container port that
disagrees with it is unreachable — and the healthcheck follows `$PORT`, so the add-on
reports healthy while being dark. The Supervisor's Configuration → Network panel is the
correct control for changing the host port. Reversal cost: restoring the option means
either templating the port mapping (not supported by the Supervisor) or accepting the
silent-failure mode again.

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
- Renaming an entity in Home Assistant orphans its allowlist row. Edit mode flags the
  orphaned tile rather than failing silently — the check is a `getAllowlist()` fetch on
  entering edit mode, because an orphan is defined by an absence and the SSE stream
  carries only the devices that exist.
- The rate limiter uses fixed windows, so 120 attempts are possible across a window
  boundary (60 in each of two windows — the intended total; only the instantaneous rate
  doubles).
- A hand-edited non-0/1 `ok` value in `action_log` reads back as `false`. Requires direct
  database tampering and fails in the safe direction.
- **The disabled portal still confirms a correct guest password.** While the portal is
  off, `POST /api/login` answers `403 portal_disabled` for the correct guest password but
  `401` for a wrong one. That is deliberate: the SPA needs the 403 to render the
  "temporarily unavailable" screen rather than a login failure. The exposure is small —
  wrong guesses still hit the per-IP rate limiter, and the attacker learns only that a
  password is valid for a portal they cannot currently use.
- **Known gap — flipping the kill-switch writes no audit row.** Neither the admin route
  nor the integration route records who disabled the portal or when. `action_log` covers
  guest device actions only. This is consistent across both paths so it is not a
  regression, but "who turned this off?" is currently unanswerable.
- **Upgrading from 0.1.x may require manual config cleanup.** If a user's saved add-on
  configuration still contains `port: 8080` from before the option was removed, the
  Supervisor flags it as an unknown option and the user must delete that line from their
  configuration. The error is visible and recoverable — unlike the silent failure the
  option caused when it existed.
- **`tiles` is a lookalike, not a port.** SF Symbols cannot ship in a web application —
  the licence covers Apple platforms only — so the theme's glyphs are drawn by hand in
  that idiom (a 24px box, an even 1.8px stroke, round caps, no fill) and no dependency is
  added for them. They will never be pixel-identical to the real thing, and a reader who
  knows the originals will see the difference. Relatedly, `cards` vendors its ten Material
  Symbols glyph paths as source rather than importing them, for the Node-loadability
  reason above; a test reads the `@material-symbols/svg-400` package's own `.svg` files
  back and fails if any vendored path has drifted, so the copies cannot rot silently.
- **Known gap — happy-dom drops a `color-mix()` value from an inline style.** Its
  inline-style parser validates standard properties and silently discards a declaration it
  cannot parse, so `backgroundColor: color-mix(…)` disappears from the element entirely.
  (A custom property such as `--badgeTint` survives, because those are passed through
  unparsed.) No unit test can therefore assert the painted result of a mix: `tiles`'
  translucent overlay layers and `cards`' 40% badge tint — which lives in a Tailwind class
  and so never reaches the DOM as a value at all — are verified only by their Playwright
  previews. What the unit tests do assert is the resolved token name reaching the DOM: a
  lit lamp takes `--stateLightActive`, a locked door `--stateLockLocked`, and the three are
  distinct. That covers the colour *logic*; the rendering is the snapshot's job.
- **Known gap — nothing in `src/web/api.ts` guards `fetch` against a network throw.** There
  is not one `try`/`catch` in the file: each function converts an HTTP failure into
  `{ ok: false, status }` and lets an offline, aborted or DNS-failed request reject instead.
  Every `void somePromise()` call site is therefore a potential unhandled rejection, and the
  visible symptom is the wrong one — the optimistic change reverts with no error shown. The
  allowlist editor and the portal title field each catch their own, and the orphan and
  catalog loads in `Portal.tsx` do too; the class is untouched. Fixing it in one api function
  was rejected as an inconsistency pretending to be a fix — either all of them return a
  network failure as `{ ok: false }`, or none do.
- **Known gap — two owners editing at once will clobber each other.** Every edit PUTs the
  whole allowlist, so the last write wins and the other owner's concurrent change is gone
  with nothing to indicate it happened. Acceptable for a single-household add-on with one
  admin password; the fix is per-device endpoints or an ETag on the allowlist, and neither
  is worth the complexity at this size.
- **Accepted risk — the base-href hardening in `src/server/app.ts` is untested.** The
  `<base href>` interpolation shares the `$`-expansion and unescaped-value defect fixed for
  the portal title, and was fixed the same way, but the ingress listener has no integration
  coverage: reaching it needs a request that appears to come from the Supervisor at
  `172.30.32.2`. The value comes from the `x-ingress-path` header on a connection the
  Supervisor gate has already accepted, so it is Supervisor-controlled rather than
  guest-controlled, which is why a two-line fix shaped exactly like the proven one was
  accepted without a test rather than left in place.
