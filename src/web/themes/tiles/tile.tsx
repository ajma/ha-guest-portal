import type { ReactElement, ReactNode } from 'react'
import { type StateColorToken, stateColorVar } from '../stateColor.js'

/**
 * The pieces every tile in this theme draws.
 *
 * The defining move is the flood: an active tile is not a card with a coloured
 * icon on it, it IS the colour, and its content inverts to `--accentText`. That
 * is one decision applied in one place — `skinFor` — so the three tiles cannot
 * drift apart on it.
 *
 * The flood colour is the resolved STATE colour, never `--accent`. Painting
 * every active tile the one accent would make an unlocked door and a lit lamp
 * identical, which is the exact confusion the state roles exist to prevent. A
 * light still floods amber, because `stateLightActive` IS the accent amber.
 */

export type TileSkin = {
  /** The tile's own background. */
  background: string
  /** Primary text and the icon glyph. */
  foreground: string
  /** The state line under the name. */
  muted: string
  /** The disc behind the icon. */
  iconBg: string
  /** A secondary control sitting on the tile. */
  pill: string
}

/**
 * `flooded` is the caller's decision, not a re-derivation of the state: a tile
 * knows things `stateColorToken` cannot, such as the device being stale.
 *
 * The translucent layers are `color-mix` over `--accentText` rather than a
 * literal black at some alpha, so the whole scheme still comes out of the token
 * set and a theme fork changing `accentText` gets a consistent tile for free.
 */
export function skinFor(token: StateColorToken, flooded: boolean): TileSkin {
  if (!flooded) {
    return {
      background: 'var(--surface)',
      foreground: 'var(--text)',
      muted: 'var(--textMuted)',
      iconBg: 'var(--surfaceActive)',
      pill: 'var(--surfaceActive)',
    }
  }

  return {
    background: stateColorVar(token),
    foreground: 'var(--accentText)',
    muted: 'color-mix(in srgb, var(--accentText) 62%, transparent)',
    iconBg: 'color-mix(in srgb, var(--accentText) 14%, transparent)',
    pill: 'color-mix(in srgb, var(--accentText) 16%, transparent)',
  }
}

/** The rounded square itself. Nothing is drawn outside it. */
export function TileCard({
  skin,
  children,
}: {
  skin: TileSkin
  children: ReactNode
}): ReactElement {
  return (
    <div
      data-testid="tile-card"
      className="overflow-hidden rounded-[var(--tileRadius)] shadow-[var(--shadow)] transition-colors duration-[180ms] ease-out"
      style={{ backgroundColor: skin.background }}
    >
      {children}
    </div>
  )
}

/**
 * The tile's content: icon top-left, name beneath it, state beneath that.
 *
 * Every element is a `span`. This markup is the direct child of a `<button>` on
 * every tile in this theme — a `<div>` is not valid content for one, and the
 * whole point of the theme is that the tile is the control.
 */
export function TileBody({
  skin,
  glyph,
  primary,
  secondary,
}: {
  skin: TileSkin
  glyph: ReactNode
  primary: string
  secondary: string
}): ReactElement {
  return (
    <span className="flex min-h-[96px] w-full flex-col items-start gap-[10px] p-[var(--tilePadding)] text-left">
      <span
        data-testid="tile-icon"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: skin.iconBg, color: skin.foreground }}
      >
        {glyph}
      </span>
      <span className="w-full min-w-0">
        <span
          className="block truncate text-[15px] font-medium leading-[1.3] tracking-[-0.2px]"
          style={{ color: skin.foreground }}
        >
          {primary}
        </span>
        <span className="block truncate text-[13px] leading-[1.3]" style={{ color: skin.muted }}>
          {secondary}
        </span>
      </span>
    </span>
  )
}

/** The whole-tile control. `w-full` is load-bearing: the tile IS the button. */
export function TileButton({
  label,
  pressed,
  onClick,
  disabled,
  describedBy,
  children,
}: {
  label: string
  pressed?: boolean | undefined
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
      aria-label={label}
      aria-pressed={pressed}
      aria-describedby={describedBy}
      className="flex w-full disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  )
}

/** A row of secondary controls, used only where the tile cannot be the control. */
export function TilePills({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="flex gap-2 px-[var(--tilePadding)] pb-[var(--tilePadding)]">{children}</div>
  )
}

export function TilePill({
  skin,
  onClick,
  disabled,
  describedBy,
  children,
}: {
  skin: TileSkin
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
      className="flex h-8 flex-1 items-center justify-center rounded-full px-3 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-60"
      style={{ backgroundColor: skin.pill, color: skin.foreground }}
    >
      {children}
    </button>
  )
}

/**
 * The strip under a tile carrying staleness and the last failed action.
 *
 * It keeps `--surface` behind it even when the tile above is flooded, because
 * `--danger` over a flood colour is the one combination this theme cannot make
 * legible — an error in red on a red unlocked-lock tile would vanish. Reading
 * the message matters more than the tile being one unbroken colour.
 */
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
      className={`bg-[var(--surface)] px-[var(--tilePadding)] py-2 text-[12px] leading-[1.3] ${
        danger ? 'text-[var(--danger)]' : 'text-[var(--textMuted)]'
      }`}
    >
      {children}
    </div>
  )
}
