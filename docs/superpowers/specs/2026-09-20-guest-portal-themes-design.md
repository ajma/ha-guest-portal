# Guest Portal Themes — Design

**Date:** 2026-09-20
**Status:** Approved
**Builds on:** `2026-09-18-ha-guest-portal-design.md`, `2026-09-19-portal-toggle-and-integration-design.md`

## Problem

The guest view looks like a developer's default: grey Tailwind utilities hardcoded
into each component, with `dark:` variants alongside them. It works, but it is the
first and often only thing a paying guest sees, and it looks like nothing they
recognise.

Owners want the portal to feel like a smart-home app the guest already knows. The
appearance should be the owner's choice, set from the admin page, and it should be
possible to add new looks later without rebuilding the guest UI each time.

## Goals

- Three visually distinct, faithful themes for the guest surface.
- The owner picks one from the admin page and sees what each looks like first.
- Adding a fourth theme is a self-contained addition, not a refactor.
- Every screen a guest can reach is themed — no unstyled seams.

## Non-goals

- Theming the admin surface. It is a configuration tool only the owner sees, it
  uses inline styles rather than Tailwind, and theming it would roughly double the
  work for no guest-visible benefit.
- Per-guest or per-device themes. One portal, one theme.
- A theme editor, custom colour pickers, or user-supplied themes. Themes are code.
- Live re-theming of already-loaded guest sessions. See "Delivery" below.

## Decisions taken

| Question | Decision |
|---|---|
| Fidelity to the originals | Faithful — each theme supplies its own tile components |
| Extensibility | Component overrides are **optional**; tokens-only themes inherit defaults |
| Icons | Per-theme icon sets |
| Screens covered | Device grid, login, and disabled screen |
| Light/dark | Each theme declares both |
| Registration | Static registry, structured so lazy loading is a later drop-in |
| Theme names | Neutral: `tiles`, `cards`, `classic` |
| Admin selector | Three preview images in a row, selectable |
| Preview source | Playwright screenshots that double as visual-regression baselines |
| Delivery to the client | Server injects `data-theme` into the HTML — no API call |

## Naming and trademark

The themes are inspired by Apple HomeKit, Google Home and Home Assistant, but ship
under neutral ids and display names — `tiles` / "Tiles", `cards` / "Cards",
`classic` / "Classic". This add-on is distributed through HACS and an add-on
repository; naming a theme after a protected mark while deliberately imitating its
trade dress is an exposure with no engineering benefit. Documentation may say
"inspired by" so the association stays discoverable.

Only `classic` can be genuinely accurate, because it uses MDI — the icon set Home
Assistant itself uses. `tiles` is necessarily a lookalike: Apple's SF Symbols are
licensed for Apple platforms and cannot ship in a web application.

## Architecture

### The theme contract

One folder per theme under `src/web/themes/<id>/`, each default-exporting:

```ts
type ThemeTokens = {
  surface: string
  surfaceRaised: string
  text: string
  textMuted: string
  accent: string
  accentText: string
  tileRadius: string
  tileGap: string
  fontFamily: string
  // Illustrative. The full list is defined once in src/web/themes/tokens.ts and
  // is CLOSED: every theme supplies every token, and no theme invents its own.
  // A theme needing a value outside the set is a signal to extend the set for
  // all themes, not to special-case one — otherwise the default component set
  // cannot render an arbitrary theme, which is the property that makes
  // overrides optional.
}

type Theme = {
  id: ThemeId
  name: string
  tokens: { light: ThemeTokens; dark: ThemeTokens }
  icon: (domain: SupportedDomain, state: string) => ReactElement
  components?: {
    Shell?: ComponentType<ShellProps>
    ToggleTile?: ComponentType<TileProps>
    CoverTile?: ComponentType<TileProps>
    LockTile?: ComponentType<TileProps>
    Login?: ComponentType<LoginProps>
    Disabled?: ComponentType<DisabledProps>
  }
}
```

`tokens` and `icon` are required. **`components` is entirely optional** — that is
the extensibility hinge. A default component set consumes tokens alone and renders
coherently for any palette. The three flagship themes override everything and get
full fidelity; a future theme that is really a reskin ships tokens and an icon
resolver and nothing else.

### The registry

`src/web/themes/registry.ts` maps id → theme, and `resolveTheme(id)` falls back to
`classic` for an unrecognised id, so a database row naming a deleted theme degrades
rather than white-screening.

All themes ship in the bundle. Three themes of tiles is an estimated 30–60 KB on a
bundle already at ~558 KB. The registry's value type is the single swap point for
lazy loading later: changing it to `() => import(...)` is a localised change, worth
making when there are eight themes rather than three.

### Tokens as CSS custom properties

Tokens are emitted as CSS custom properties on the root element, not threaded
through React props. Components reference them through Tailwind arbitrary values
(`bg-[var(--surface)]`). Light and dark are the same variable names under a
`prefers-color-scheme` media query, so switching costs no re-render and no
JavaScript.

```css
[data-theme='tiles'] {
  --surface: #1c1c1e;
  --tile-radius: 20px;
  /* ... */
}
@media (prefers-color-scheme: light) {
  [data-theme='tiles'] { --surface: #f2f2f7; /* ... */ }
}
```

## The three themes

| | **tiles** | **cards** | **classic** |
|---|---|---|---|
| Inspired by | HomeKit | Google Home | Home Assistant |
| Tile shape | Large rounded square, ~20px radius | Airy rounded rect, large circular icon | Compact card, 12px radius |
| On-state | Whole tile floods with accent colour | Icon circle fills; card stays light | Small accent toggle; card unchanged |
| Layout | Icon top-left; name and state stacked below | Centred circular icon; label beneath | Icon left · name/state centre · control right |
| Interaction | Tap anywhere on the tile | Tap the icon; card body inert | Explicit control on the right |
| Default mode | Dark-first | Light-first | Follows device |
| Icons | SF-Symbols-like open set | Material Symbols | MDI |

All three override every component, including their own login and disabled screens,
so a guest never crosses a visual seam. That is a property of these three themes,
not a requirement of the contract — a future reskin theme omits `components`
entirely and inherits the defaults.

## Build order

The spec describes one feature, but it should be built in three stages, each
producing working software:

1. **Infrastructure plus `classic`.** Shared ids, settings, server injection and the
   root-path fix, the admin route, the contract, the registry, the token CSS, the
   default component set, the admin picker, and the preview pipeline — with one
   theme wired through it. At the end of this stage the portal is themed and the
   picker works, with a single option.
2. **`tiles`.** Should touch only `src/web/themes/tiles/` plus its preview baseline.
3. **`cards`.** Likewise.

Stages 2 and 3 are the real test of the design: if either requires changes outside
its own folder, the contract is wrong and should be fixed then rather than
papered over. Building `classic` first is deliberate — it is the theme whose
reference implementation is closest to what already exists, so the infrastructure is
proven against the cheapest theme before the expensive ones are attempted.

## Persistence

The `settings` table gains one key. No schema change — it is already key/value.

| Key | Value |
|---|---|
| `portal_theme` | a member of `THEME_IDS`; default `classic` |

`SettingsStore` gains `getTheme(): ThemeId` and `setTheme(id: ThemeId): void`,
mirroring the existing enabled flag. An unrecognised stored value reads back as
`classic` rather than throwing, matching how `getPortalEnabled` treats an absent
row.

**`src/shared/themes.ts` is the contract between the two halves:**

```ts
export const THEME_IDS = ['tiles', 'cards', 'classic'] as const
export type ThemeId = (typeof THEME_IDS)[number]
```

The server cannot import from `src/web` without dragging the client bundle into the
server build, so the id list lives in `shared/` where both sides already import
from. A unit test asserts the web registry's keys equal `THEME_IDS`, so adding a
theme to one and not the other fails immediately rather than at runtime.

## Delivery

**The server writes the theme into the HTML. There is no theme API endpoint.**

`src/server/app.ts` already reads `dist/web/index.html` and injects `<base href>`
before serving. The theme is one more mutation in the same place:

```ts
html = html
  .replace(/(<head[^>]*>)/i, `$1\n    <base href="${normalizedBase}">`)
  .replace(/<html/i, `<html data-theme="${settings.getTheme()}"`)
```

Because the attribute lands on `<html>`, the CSS variable block applies during HTML
parse — before React loads. There is no unthemed flash, including on the existing
"Loading..." gate. A fetched theme could not achieve that however well
parallelised, and would add a route requiring its own authentication decision.

The client reads `document.documentElement.dataset.theme` synchronously at boot to
select the component set.

### The root path bypasses injection today

`app.ts` registers `serveStatic({ root: './dist/web' })` and the SPA fallback both
on `/*`. `serveStatic` resolves `/` to `index.html` and answers first, so the
fallback never runs for the root URL. Verified against the running server:

```
GET /admin  →  <base href="/">   (fallback ran)
GET /       →  no base href      (serveStatic answered)
```

This is latent today because the built HTML uses relative `./assets/…` paths, so
nothing breaks without `<base href>`. But `/` is the URL every guest opens, so
injecting the theme only in the fallback would leave the guest surface unthemed
while the admin surface worked.

**Fix as part of this work:** extract the injection into one function, and call it
from both an explicit `/` handler registered *before* `serveStatic` and the
existing fallback. `/` and `/admin` then behave identically, which also closes the
pre-existing ingress base-href gap at the root.

### Development parity

Vite serves `index.html` at :5173 without touching the Node server, so a small Vite
plugin using `transformIndexHtml` injects `data-theme` from a `PORTAL_THEME`
environment variable, defaulting to `classic`. Same shape in both environments,
sourced differently, and explicitly dev-only.

### Already-loaded sessions keep their theme

A guest with the portal open when the owner changes the theme keeps the old one
until they reload. The SSE hub could carry a theme frame — the `portal` frame
already establishes the pattern — but the owner judges a theme by the admin
preview, not by watching a guest's screen, and restyling under someone's thumb
mid-tap is worse than not. Deliberate omission.

## HTTP API

```
GET /api/admin/portal
    → { enabled, integrationToken, portalId, theme }     // theme is new

PUT /api/admin/theme          { theme: ThemeId }
    → { theme }
```

Reads stay combined; writes stay single-purpose, matching the existing toggle. The
request body is validated against `THEME_IDS`; an unrecognised id returns 400 with
Zod's first issue message, consistent with the other admin PUT handlers. Both routes
sit behind the existing `/api/admin/*` admin-role guard.

## Admin picker

Three previews in a row, above the existing kill-switch section.

- Real radio-group semantics (`role="radiogroup"`, arrow-key navigable, each option
  labelled). It is a form control, not three clickable divs.
- Selection takes effect on click, with an optimistic update and revert-on-failure —
  the pattern `PortalToggle` already established.
- Each option shows the theme's display name and its preview image, with a visible
  selected state that does not rely on colour alone.

## Preview pipeline

The preview images and the visual-regression baselines are **the same files**.

```
test/e2e/theme-previews.spec.ts
  for each id in THEME_IDS:
    render the guest grid with a fixed device set
    expect(page).toHaveScreenshot(`${id}.png`)
        └── baseline path: src/web/theme-previews/<id>.png
            which is what the admin picker imports
```

Consequences:

- Changing a theme's appearance makes the screenshot test **fail**. Regenerating
  with `pnpm test:e2e --update-snapshots` updates the preview. Staleness becomes a
  failing test rather than a matter of discipline.
- Adding a theme without capturing a preview fails a unit test asserting every
  `THEME_IDS` entry has a preview file.

This matters because there is no CI in this repository: "auto-captured in CI" would
otherwise mean "captured when someone remembers".

The fixed device set is defined once and shared by all three captures, so the
previews differ only by theme.

## Testing

**Unit**
- `resolveTheme` returns the named theme for each valid id.
- `resolveTheme` falls back to `classic` for an unknown id rather than throwing.
- The registry's keys equal `THEME_IDS`.
- Every theme declares both light and dark tokens, and an icon resolver.
- Every `THEME_IDS` entry has a preview file on disk.
- `SettingsStore.getTheme` defaults to `classic`; an unrecognised stored value also
  reads back as `classic`.

**Component**
- Each theme's tiles render for every supported domain, in light and dark.
- **A synthetic tokens-only fixture theme renders correctly through the default
  component set.** This is the guarantee that optional overrides actually work;
  testing it with one of the three real themes would prove nothing, because they all
  override everything.

**Integration**
- `PUT /api/admin/theme` persists a valid id and returns it.
- An id outside `THEME_IDS` returns 400 and leaves the stored value unchanged.
- A guest session gets 403; an anonymous request gets 401.
- `GET /api/admin/portal` includes the current theme.
- `GET /` and `GET /admin` both carry `data-theme` and `<base href>` — the
  regression guard for the root-path bug above.

**E2E**
- The owner selects a theme; a guest reload shows it.
- `theme-previews.spec.ts` doubles as the preview generator.

## Accepted risks

- All themes ship in every bundle. Acceptable at three; the registry is the single
  swap point when lazy loading becomes worthwhile.
- `tiles` is a lookalike rather than a reproduction, because SF Symbols cannot be
  shipped in a web application.
- Preview images are captured from a real browser, so they can differ slightly
  across platforms. Playwright's snapshot comparison has a configurable threshold;
  if cross-machine noise becomes a problem the previews should be captured in one
  environment rather than the threshold being loosened until it hides real change.
- A guest with the portal already open keeps the previous theme until reload.
