import type { ReactElement, ReactNode } from 'react'
import { type StateColorToken, stateColorVar } from '../stateColor.js'

/**
 * The pieces of Home Assistant's tile card, transcribed from
 * `src/components/tile/ha-tile-{container,icon,info}.ts`,
 * `src/panels/lovelace/cards/tile/tile-card-style.ts` and
 * `src/components/ha-control-button.ts`.
 *
 * They live in one module because all three tiles draw the same card: a 56px
 * row of icon + two lines of text, with an optional row of feature buttons
 * beneath it. Three copies of that markup would drift on the first change.
 *
 * Every colour arrives as a CSS custom property. The state colour has to go
 * through an inline `style` rather than a Tailwind class: the token is chosen
 * at runtime by `stateColorToken`, and Tailwind only emits classes it can read
 * as literal strings at build time.
 */

/** ha-card: 12px radius, flat, with the divider colour as a 1px edge. */
export function TileCard({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="overflow-hidden rounded-[var(--tileRadius)] border border-[var(--border)] bg-[var(--surface)]">
      {children}
    </div>
  )
}

/**
 * ha-tile-icon: a 36px pill filled with the state colour at 20%, carrying a
 * 24px glyph in the same colour at full strength. Two layers rather than one
 * `color-mix` because the glyph must not inherit the fade.
 *
 * Home Assistant gives the icon slot `padding: 6px; margin: -6px` so its ripple
 * overflows the shape. Padding and margin cancel exactly, so the margin box is
 * still 36px and the row lays out identically without it; this theme has no
 * ripple, so the wrapper would be a DOM node that changes nothing.
 */
export function TileIcon({
  token,
  glyph,
}: {
  token: StateColorToken
  glyph: ReactNode
}): ReactElement {
  return (
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
      <span
        aria-hidden="true"
        data-testid="tile-icon-bg"
        className="absolute inset-0 rounded-full opacity-[0.2] transition-[background-color,opacity] duration-[180ms] ease-in-out group-hover:opacity-[0.35]"
        style={{ backgroundColor: stateColorVar(token) }}
      />
      <span
        className="relative flex transition-[color] duration-[180ms] ease-in-out"
        style={{ color: stateColorVar(token) }}
      >
        {glyph}
      </span>
    </span>
  )
}

/**
 * ha-tile-info: 14px/500 primary over 12px/400 secondary, both ellipsised. The
 * line heights and letter spacings are Home Assistant's, not defaults — they
 * are what makes the two lines sit at the right optical distance inside 56px.
 */
export function TileInfo({
  primary,
  secondary,
}: {
  primary: string
  secondary: string
}): ReactElement {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[14px] font-medium leading-[1.6] tracking-[0.1px] text-[var(--text)]">
        {primary}
      </span>
      <span className="block truncate text-[12px] font-normal leading-[1.2] tracking-[0.4px] text-[var(--textMuted)]">
        {secondary}
      </span>
    </span>
  )
}

/** ha-tile-container's `.content`: the 56px icon-and-text row. */
export const TILE_ROW_CLASS = 'flex min-h-[56px] w-full items-center gap-[10px] px-[10px] text-left'

/**
 * The features slot. Home Assistant puts cover and lock controls in a row
 * BENEATH the info row, never inline to its right. The 12px gap is
 * ha-control-button-group's `--control-button-group-spacing`, and the padding
 * is the tile card's own `0 12px 12px`.
 */
export function TileFeatures({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex gap-3 px-3 pb-3">{children}</div>
}

/**
 * ha-control-button: `--feature-height` (36px) tall, 8px radius, 8px padding,
 * 14px/500 text in the primary colour.
 *
 * The fill is NEUTRAL and takes no `token`. Home Assistant's
 * `card-feature-styles.ts` passes `ha-control-button` a radius and
 * `--control-button-focus-color: var(--feature-color)` and nothing else, so
 * `--control-button-background-color` keeps its default of `--disabled-color`
 * at 20%: every feature button is the same grey on every domain and in every
 * state. Only the icon circle carries the state colour.
 *
 * Still the two-layer construction the icon uses, and for the same reason —
 * a single translucent background would take the label down with it.
 */
export function ControlButton({
  onClick,
  disabled,
  describedBy,
  children,
}: {
  onClick: () => void
  disabled: boolean
  describedBy?: string | undefined
  children: ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-describedby={describedBy}
      className="relative flex h-9 flex-1 items-center justify-center overflow-hidden rounded-[8px] p-2 text-[14px] font-medium text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        aria-hidden="true"
        data-testid="control-button-bg"
        className="absolute inset-0 opacity-[0.2]"
        style={{ backgroundColor: 'var(--controlNeutral)' }}
      />
      <span className="relative">{children}</span>
    </button>
  )
}

/** The note rows under a tile: staleness and the last failed action. */
export function TileNote({
  children,
  id,
  danger = false,
  live = false,
}: {
  children: ReactNode
  id?: string | undefined
  danger?: boolean
  live?: boolean
}): ReactElement {
  return (
    <div
      id={id}
      aria-live={live ? 'polite' : undefined}
      className={`px-3 pb-3 text-[12px] leading-[1.2] tracking-[0.4px] ${
        danger ? 'text-[var(--danger)]' : 'text-[var(--textMuted)]'
      }`}
    >
      {children}
    </div>
  )
}
