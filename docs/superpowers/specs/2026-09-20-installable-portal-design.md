# Installable Portal — Design

**Status:** approved in brainstorming, not yet planned
**Date:** 2026-09-20

## Goal

The portal installs to a phone or desktop home screen as a PWA. Opening it where
the portal cannot be reached shows the portal's own "can't reach it" screen
rather than the browser's error page.

## Why

A guest who has to find a URL will not use the portal twice. An icon they tap is
the difference between a feature and a demo.

That only works if the app survives being opened at the wrong moment. Without a
service worker the browser owns the failure, and a guest sees a Chrome error
page about a hostname they do not recognise. With one, the portal explains
itself.

## A correction to the premise, carried into the design

**We cannot detect "not home". We can detect "the portal did not answer".** The
two differ in both directions: the portal is reachable over Tailscale from
anywhere, and it is unreachable from the sofa when the add-on is stopped.

So the screen says what is actually known — *"Can't reach the guest portal"* —
and offers the likely cause rather than asserting it. Naming the cause is still
useful; claiming to have measured it is not.

## Scope

In:

- a web app manifest, icons, and the `<head>` wiring that makes the portal
  installable
- a service worker that caches the app shell and nothing else
- an unreachable screen, rendered through the theme

Out:

- offline *functionality* of any kind — see "What is never cached"
- push notifications, background sync, any other service-worker capability
- installability through Home Assistant ingress (see "Ingress")
- **restricting the portal to the LAN.** An option to reject non-private source
  addresses was designed and then dropped: under the add-on's Docker bridge
  networking the container may see the bridge gateway's address rather than the
  client's, and the gateway's address is itself private — so the gate would pass
  everything while appearing to work. A security control that fails open
  silently is worse than none, and the portal remains reachable from the whole
  tailnet. That is an accepted exposure, governed by the password, not something
  this feature pretends to fix.

---

### Manifest and icons

`index.html` gains a manifest link, an `apple-touch-icon` and a `theme-color`.
The manifest declares `name`, `short_name`, `start_url: "/"`,
`display: "standalone"`, `background_color`, `theme_color`, and icons at 192 and
512 plus a `maskable` variant.

Icons are generated from `brand/icon.png` (256×256) at build time. The 512 is an
upscale and will be slightly soft; accepted, and noted here so nobody mistakes it
for a mistake later.

`theme_color` and `background_color` are static values, not theme tokens. They
are read by the OS before any stylesheet loads, so they cannot vary with the
owner's chosen theme. They should match the default theme's `appBg`.

### The service worker

Caches on install: `index.html`, the hashed JS and CSS bundles, the icons, the
manifest.

- **Navigation requests are network-first**, falling back to the cached
  `index.html`. A fresh shell wins whenever the portal is reachable, so an add-on
  update is picked up on the next online load rather than being pinned by the
  cache.
- **Hashed assets are cache-first.** Their names change when their contents do,
  so a hit is always correct. `activate` deletes entries from older cache
  versions.
- **`/api/*` is never touched** — see below.

Registered from `src/web/main.tsx`, and only in a production build. Registering
under `vite dev` would serve a stale shell over the dev server and cost an hour
to diagnose.

`/sw.js` must be served from the root so its scope covers the whole app, and
must not be swallowed by the SPA fallback. It is a static file in the build
output, so `serveStatic` answers it before the fallback runs — but that ordering
is load-bearing and should have a test.

### What is never cached

**No API response is ever cached. Not device state, not the session, not the
catalog.**

This is the most important decision in the feature. A cached `/api/devices`
would let a guest open the portal away from the house and be shown a lock
reading "Locked" as of an hour ago — a confident, stale, safety-relevant claim.
Showing nothing is strictly better than showing something false about a lock.

The service worker therefore passes every `/api/*` request straight to the
network and lets it fail.

### The unreachable screen

`App` resolves the session on mount with `void checkSession()` and no `catch`
(`src/web/App.tsx:29-39`). `getSession()` does a bare `await fetch(...)` and
returns `null` only for a 401, so a *network* failure rejects. The rejection
escapes, `setRole` is never called, and the app sits on `Loading...` forever
(`App.tsx:92`) while the console carries an unhandled rejection.

So the current off-network behaviour is not "shows a login form it cannot
submit" — it is a permanent spinner. That is exactly the failure the cached
shell would otherwise preserve, and this feature fixes it as a consequence.

A third state joins `loading` and `null`:

- the request **rejected** (no network, DNS failure, connection refused) →
  `unreachable`
- the request **answered** with no session → `null`, as now → Login

`unreachable` renders the themed screen: *"Can't reach the guest portal"*, *"You
may need to be on the home Wi-Fi"*, and a Retry button that re-runs the session
check. It reuses the existing `Disabled` slot's shape so it looks like the
portal, not like a browser.

The cached shell carries whatever `data-theme` the server injected when it was
cached, so changing theme while away leaves the unreachable screen on the old
one until the next online load. Accepted; not worth a mechanism.

### Ingress

Out of scope. Ingress serves the app under a session-scoped path that changes,
which is not a stable `start_url`, and the owner reaching their own portal from
inside Home Assistant's sidebar does not need an icon. The manifest is served on
both listeners because it is a static file; nothing prevents an install from
ingress, but it is not supported and not tested.

---

## Error handling

- **Session request rejects** → `unreachable`, with Retry. Not a login prompt.
- **Session request answers 401/none** → Login, as today.
- **Service worker registration fails** (unsupported browser, insecure context)
  → the app runs exactly as it does now. Registration is a progressive
  enhancement and must never block boot.

## Testing

- `App` renders the unreachable screen on a rejected session request and the
  login form on an answered one. The mutant to kill is treating both as "no
  session".
- Retry re-runs the check and recovers.
- The service worker never intercepts `/api/*`.
- `/sw.js` and the manifest are served from the root with the right content
  types, ahead of the SPA fallback.
- Manifest validity: the fields installability actually requires are present.

## Risks

- **A stale shell.** Mitigated by network-first navigation; a genuinely offline
  guest may still see an older shell, which only ever renders the unreachable
  screen anyway.
- **Service workers are sticky.** A bad one is hard to remove from a guest's
  device. The registration must be simple enough to reason about in one sitting,
  and the cache version must change whenever the cached set does.
- **`theme_color` cannot follow the theme.** Accepted; it is OS chrome, not app
  surface.
