# Single-Page Portal — Design

**Status:** approved in brainstorming, not yet planned
**Date:** 2026-09-20
**Supersedes:** the separate `/admin` route introduced in the original build

## Goal

Guests and owners land on the same page. The portal *is* the product surface;
owning it is a mode on top of that surface, not a different screen. An owner
gets two extra buttons — **Edit** and **Settings** — and nothing else changes.
The admin page is deleted.

## Why

Today an owner configures the portal on a screen that looks nothing like the
portal and is reached by a URL guests never see. The consequence is that you
cannot tell what you are shipping until you go and look at it: the admin page
lists devices as rows of form controls while guests get a themed grid. Editing
the thing you are looking at removes that indirection entirely.

It also removes a whole surface. `Admin.tsx` renders its own header, its own
device list, its own save model and its own layout, none of which a guest ever
sees and all of which has to be maintained alongside the themed components that
do the same job.

## Scope

In:

- one page for both roles, with role deciding only whether the two owner
  buttons appear
- an **Edit** mode over the live grid: per-device editing, reordering, removal,
  and a ghost tile that adds a device
- a **Settings** panel holding what remains of the admin page: theme picker,
  portal kill switch, and a new portal title
- a configurable portal title, replacing the hardcoded `Guest Portal`
- deletion of `src/web/routes/Admin.tsx` and every reference to `/admin`

Out:

- drag-to-reorder (see *Reordering*)
- any change to the guest-visible grid in its normal state
- any change to authentication, the session model, or the HA integration
- new Theme contract components (see *Styling the owner surfaces*)

## Architecture

`App` resolves the session as it does now, then renders the themed portal for
**both** roles. The grid is byte-identical between a guest and an owner in
normal mode. Role feeds exactly one decision: whether `headerActions` is
populated.

```
App
 ├─ role === null            → themed Login
 ├─ role === 'guest' && !on  → themed Disabled
 └─ otherwise                → Portal
                                 ├─ Shell (themed)  ← title, headerActions
                                 │    └─ device grid (themed tiles)
                                 ├─ EditLayer    (owner, when editing)
                                 └─ SettingsPanel(owner, when open)
```

`EditLayer` and `SettingsPanel` are overlays over the one page. Neither is a
route; nothing about them appears in the URL. Each of the two header buttons
toggles its own overlay; opening one closes the other, so the two modes are
mutually exclusive rather than stacking.

`src/web/routes/Guest.tsx` is renamed to `Portal.tsx` and its component from
`Guest` to `Portal`. It now serves both roles, and leaving it called `Guest`
would misdescribe the only page in the application.

### Page states

**Normal.** Exactly today's guest portal. An owner additionally sees Edit and
Settings in the header.

**Edit.** Entered and left by the Edit button. Tiles remain themed and live, and
the mode is visibly distinct so an owner cannot mistake it for normal. Tapping a
tile opens an editor for that device: rename, allowed actions, move up, move
down, remove. A ghost tile at the end of the grid opens the entity picker.
Leaving edit mode returns to normal; there is nothing to commit, because every
change already saved.

In edit mode a tap edits rather than actuates — tapping a light tile opens its
editor, it does not switch the light on. That is the one place the mode changes
what an existing gesture does, so the visual distinction above is load-bearing
rather than decorative.

**Settings.** A panel over the page containing the theme picker, the portal kill
switch, and the portal title field. This is the entire remaining content of the
old admin page.

## Contract changes

`ShellProps` gains two fields:

```ts
export type ShellProps = {
  children: ReactElement | ReactElement[]
  onLogout: () => void
  loggingOut: boolean
  title: string
  headerActions?: ReactElement
}
```

All four Shells — `default`, `classic`, `tiles`, `cards` — render both. `title`
replaces the string each currently hardcodes. `headerActions` is placed in the
header in whatever way suits the theme.

**A contract test asserts every registered theme's Shell renders what it is
handed.** This is the one real footgun in the design: a future theme that quietly
drops `headerActions` locks an owner out of their own settings, with the portal
still looking perfectly fine. The test makes that a build failure rather than a
support question. It renders each registered theme's Shell with a sentinel in
`headerActions` and a known `title`, and asserts both appear.

This is one optional prop and one required prop, not new components. A theme
remains one folder plus one registry line.

## The portal title

A new settings row beside the theme, defaulting to `Guest Portal`.

**It is injected into the HTML, not fetched.** The server already rewrites
`<html data-theme=…>` on every document request; it sets the title in the same
pass. Three reasons:

- the header is correct on first paint, with no flash of a default title and no
  render-blocking request, which is the same property the theme injection exists
  for
- guests need it, and guests have no admin endpoints — injection avoids adding a
  public settings endpoint purely to serve one string
- the `<title>` element comes free from the same value

Persistence mirrors the theme exactly: a row in the settings store, exposed on
`GET /api/admin/portal`, written by a new `PUT /api/admin/title`.

The title is owner-supplied text rendered into HTML, so it must be escaped at
the injection point. A title containing `</html>` or a `<script>` tag must not
be able to break the document or execute — this is the one genuinely new
injection surface in the change, and it is owner-controlled rather than
guest-controlled, which lowers but does not remove the concern.

## Save semantics

**Every edit saves immediately.** There is no Save button, no dirty state and no
unsaved-changes warning.

The decisive reason is that this page holds a live SSE stream. Today's admin page
batches edits in React state and PUTs once, which works only because it never
subscribes to anything. Merge the pages and the same component would hold
incoming device snapshots *and* pending structural edits, so every frame would
have to be reconciled against uncommitted local changes. Saving instantly means
the stream is always authoritative and the reconciliation problem does not exist.

Mechanically: each mutation computes the new full allowlist and PUTs it through
the existing `putAllowlist`, applied optimistically and reverted on failure —
the pattern the theme picker and kill switch already use. The server broadcasts a
fresh snapshot, and the grid converges on it. No new endpoints.

### New devices are added inert

A device added from the picker gets **no allowed actions**. Every theme already
renders that as a `No actions available` tile, an existing and tested path.

The consequence is deliberate and worth stating: a guest watching the portal sees
an inert tile appear the moment an owner adds a device, before it is configured.
The alternative — a persisted hidden flag — was considered and set aside as a new
column and a new visibility concept in the data model to solve a cosmetic problem.
Inert-but-visible is honest and cannot be actuated.

## Styling the owner surfaces

The tile editor, entity picker and settings panel are **one implementation that
reads the theme tokens**, not theme components.

They take their colours, radius and font from the CSS variables (`--surface`,
`--text`, `--accent`, `--tileRadius`, `--fontFamily`, …), so they adopt each
theme's palette automatically, including dark mode and including themes that do
not exist yet. But they add no slots to the Theme contract, so adding a theme is
still one folder.

This reverses the existing decision that "the admin surface is not themed", which
was correct when the admin surface was a separate page and is wrong once a dialog
opens over a themed grid. It is cheap: those components already use inline styles,
so it is substituting `var(--token)` for hex literals.

## Reordering

**Move up / move down in the tile editor. No drag-and-drop.**

Drag is the most work in this change, the most fragile on touch, and the hardest
to make accessible and testable. The arrows cost nothing, already exist in the
admin page, and work with a keyboard and a screen reader. Drag can be added later
if the arrows prove annoying; it is a pure enhancement with no data implications.

## `/admin`

Removed as though it never existed. No redirect, no deep link, no special
handling — the owner has not released this build, so there are no bookmarks to
honour. References go from `README.md`, `scripts/dev-demo.sh`, and the tests that
navigate there.

`/admin` remains an ordinary SPA path in the sense that the server's fallback
serves `index.html` for it, exactly as it does for any non-API path. The existing
server-side test asserting theme injection on `/admin` stays valid on that basis,
though it should be reworded so it no longer implies an admin page exists.

## Error handling

- **A failed mutation** reverts the optimistic change and surfaces the error in
  the editor that caused it, not as a page-level banner.
- **A device deleted from another session** while its editor is open: the
  incoming snapshot no longer contains it, and the editor closes rather than
  editing a ghost.
- **A failed settings write** behaves as the theme picker already does — revert
  the control, show the error, offer retry.
- **Edit mode while the portal is disabled** is allowed. An owner switching the
  portal off then fixing its contents is a reasonable sequence, and the kill
  switch governs guests, not owners.

## Testing

The governing property: **40 existing tests cover behaviour that is moving, not
disappearing** — 15 in `admin-screen.test.tsx` and 25 in `entity-picker.test.tsx`.
Renaming, action toggles, reordering, removal, and the picker's search and
filtering all still have to work; only their host changes. Those tests are
repointed at the new components with their assertions intact. **If one fails, the
new component is wrong, not the test.** This is the same safety property that
governed the headless-hook extraction and the theme wiring, and it is the main
defence against a restructure quietly losing behaviour.

New coverage:

- role decides `headerActions`: an owner sees Edit and Settings, a guest sees
  neither, asserted through the rendered page rather than a prop
- the Shell contract test across all four themes
- optimistic save and revert for each mutation kind
- the title round-trip: settings store → `GET /api/admin/portal` → HTML injection
  → rendered header, plus escaping of a hostile title
- a new device arrives with no actions and renders inert

E2E moves from deep-linking `/admin` to clicking the real buttons, which exercises
more than it did before: owner logs in, opens Edit, adds a device, and a guest in
a second context sees it appear; owner changes the title, and the guest's next
load shows it.

## Risks

- **Behaviour loss during the move.** Largest risk; mitigated by the 40-test
  property above.
- **A theme dropping `headerActions`.** Mitigated by the contract test.
- **Title injection.** Owner-controlled text written into HTML; must be escaped
  and tested with a hostile value.
- **Inert tiles visible to guests.** Accepted, as described above.
- **The grid is now an editing surface.** A mis-tap in edit mode changes what
  guests see immediately, with no undo. Removal is the destructive case; it
  should confirm.
