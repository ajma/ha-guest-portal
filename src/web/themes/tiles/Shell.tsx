import type { ReactElement } from 'react'
import type { ShellProps } from '../types.js'

/**
 * A large title over a two-column grid of squares, on a flat `--appBg` that is
 * true black in dark mode. No toolbar and no card around the grid: the tiles
 * are the only raised thing on the screen, which is what makes the flood read.
 *
 * Two columns at phone width is the theme, not a breakpoint accident — a
 * single column would turn the squares into rows and lose the shape entirely.
 */
export function Shell({
  children,
  onLogout,
  loggingOut,
  title,
  headerActions,
  belowHeader,
}: ShellProps): ReactElement {
  return (
    <div
      data-testid="guest-screen"
      className="min-h-screen bg-[var(--appBg)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <header className="flex items-center justify-between px-[var(--tilePadding)] pt-[var(--tilePadding)] pb-3">
        <h1 className="text-[24px] font-bold leading-none tracking-[-0.5px] text-[var(--text)]">
          {title}
        </h1>
        <div className="flex items-center gap-2">
          {headerActions}
          {onLogout !== undefined && (
            <button
              type="button"
              onClick={onLogout}
              disabled={loggingOut}
              className="rounded-full bg-[var(--surface)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--text)] shadow-[var(--shadow)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loggingOut ? 'Logging out...' : 'Log out'}
            </button>
          )}
        </div>
      </header>

      <div className="px-[var(--tilePadding)] pb-[var(--tilePadding)]">
        {belowHeader}
        <div className="grid max-w-5xl grid-cols-2 gap-[var(--tileGap)] md:grid-cols-3 lg:grid-cols-4">
          {children}
        </div>
      </div>
    </div>
  )
}
