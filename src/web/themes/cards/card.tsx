import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { type StateColorToken, stateColorVar } from '../stateColor.js'

/**
 * The pieces every card in this theme draws.
 *
 * The defining move is where the control is: a card is a quiet rounded
 * rectangle with a large circular badge at the top, and the BADGE is the
 * button. The name and the state sit beneath it, outside the control, so the
 * card body is inert — nothing happens if a guest rests a thumb on the text.
 * That is the opposite of `tiles`, where the whole square is the control, and
 * it is why these pieces live in one module: three copies of the markup would
 * drift on the first change.
 */

export type BadgeSkin = {
  /** The colour the disc is made from, handed to CSS as `--badgeTint`. */
  tint: string
  /** How that tint is painted — full strength, or mixed into the card. */
  fill: string
  /** The glyph itself, and nothing else — the card's text never uses this. */
  foreground: string
}

/**
 * An active badge is a TONAL fill, not a solid one, and that is a contrast
 * decision rather than a stylistic one.
 *
 * With Material's palette NO single foreground token is legible on all nine
 * solid state fills: `--accentText` (white in light mode) lands at 1.9:1 on the
 * amber of a lit light and 2.5:1 on the cyan of a running fan, while `--text`
 * fails just as badly on the purple and the red. Mixing the state colour into
 * `--surface` keeps the badge's luminance near the card's, so `--text` stays
 * legible on top — 8.1:1 at worst in light mode, 4.3:1 at worst in dark — while
 * the hue still says which device is doing what. 40% is where the tint is
 * unmistakable at a glance without pushing the dark-mode amber below 4.5:1.
 *
 * The chosen colour reaches CSS as a custom property rather than as a
 * `backgroundColor`, because the token is picked at runtime and Tailwind only
 * emits classes it can read as literal strings at build time. The mix is in the
 * class; only which colour to mix is dynamic.
 */
const TINTED = 'bg-[color-mix(in_srgb,var(--badgeTint)_40%,var(--surface))]'
const PLAIN = 'bg-[var(--badgeTint)]'

/**
 * `active` is the caller's decision, not a re-derivation of the state: a card
 * knows things `stateColorToken` cannot, such as the device being stale.
 */
export function badgeFor(token: StateColorToken, active: boolean): BadgeSkin {
  if (!active) {
    return { tint: 'var(--surfaceActive)', fill: PLAIN, foreground: 'var(--textMuted)' }
  }

  return { tint: stateColorVar(token), fill: TINTED, foreground: 'var(--text)' }
}

/**
 * React's `CSSProperties` has no index signature for custom properties, so a
 * cast is the standard way to set one. Kept in one place rather than repeated
 * at both call sites.
 */
function badgeStyle(skin: BadgeSkin): CSSProperties {
  return { '--badgeTint': skin.tint, color: skin.foreground } as CSSProperties
}

/** The rounded rectangle. Airy, flat, and centred on its badge. */
export function Card({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      data-testid="tile-card"
      className="flex flex-col items-center rounded-[var(--tileRadius)] bg-[var(--surface)] p-[var(--tilePadding)] text-center shadow-[var(--shadow)]"
    >
      {children}
    </div>
  )
}

const BADGE = 'flex h-14 w-14 shrink-0 items-center justify-center rounded-full'

/**
 * The control. Deliberately NOT `w-full`: the tap target is the 56px disc, and
 * `test/unit/theme-cards.test.tsx` asserts as much, because a card whose body
 * were also tappable would be a different theme.
 */
export function BadgeButton({
  skin,
  label,
  pressed,
  onClick,
  disabled,
  describedBy,
  children,
}: {
  skin: BadgeSkin
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
      data-testid="tile-badge"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      aria-describedby={describedBy}
      className={`${BADGE} ${skin.fill} cursor-pointer transition-colors duration-[180ms] ease-out disabled:cursor-not-allowed disabled:opacity-60`}
      style={badgeStyle(skin)}
    >
      {children}
    </button>
  )
}

/**
 * The same disc with nothing behind it, for a device the guest cannot act on.
 * A disabled `<button>` would be the wrong element: there is no action to
 * offer, so there should be nothing in the tab order to find.
 */
export function BadgeMark({
  skin,
  children,
}: {
  skin: BadgeSkin
  children: ReactNode
}): ReactElement {
  return (
    <span data-testid="tile-badge" className={`${BADGE} ${skin.fill}`} style={badgeStyle(skin)}>
      {children}
    </span>
  )
}

/** Name over state, centred under the badge. Inert — it is not in the control. */
export function CardText({
  primary,
  secondary,
}: {
  primary: string
  secondary: string
}): ReactElement {
  return (
    <span className="mt-3 w-full min-w-0">
      <span className="block truncate text-[15px] font-medium leading-[1.4] text-[var(--text)]">
        {primary}
      </span>
      <span className="block truncate text-[13px] leading-[1.4] text-[var(--textMuted)]">
        {secondary}
      </span>
    </span>
  )
}

/** The line under the text carrying staleness and the last failed action. */
export function CardNote({
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
    <p
      id={id}
      aria-live={live ? 'polite' : undefined}
      className={`mt-2 text-[12px] leading-[1.4] ${
        danger ? 'text-[var(--danger)]' : 'text-[var(--textMuted)]'
      }`}
    >
      {children}
    </p>
  )
}

/** The two explicit choices an unlock confirmation offers. */
export function CardActions({ children }: { children: ReactNode }): ReactElement {
  return <div className="mt-3 flex w-full gap-2">{children}</div>
}

export function CardAction({
  primary = false,
  onClick,
  disabled,
  describedBy,
  children,
}: {
  primary?: boolean
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
      className={`h-9 flex-1 cursor-pointer rounded-full px-3 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
        primary
          ? 'bg-[var(--accent)] text-[var(--accentText)]'
          : 'bg-[var(--surfaceActive)] text-[var(--text)]'
      }`}
    >
      {children}
    </button>
  )
}
