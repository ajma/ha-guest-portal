import type { ReactElement } from 'react'
import type { ShellProps } from '../types.js'

/**
 * A white page with pale cards on it, and a flowing grid rather than a fixed
 * column count: the cards centre their own contents, so they need to stay wide
 * enough to do that on a phone while still filling a desktop window. `auto-fill`
 * with a 168px floor gives two columns at phone width and as many as fit above
 * that, without a breakpoint per size.
 *
 * The header is Material's: a large plain title, and a text button for the one
 * action rather than a filled one — logging out is not the thing the page is
 * for.
 */
export function Shell({ children, onLogout, loggingOut }: ShellProps): ReactElement {
  return (
    <div
      data-testid="guest-screen"
      className="min-h-screen bg-[var(--appBg)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <header className="flex items-center justify-between px-[var(--tilePadding)] pt-[var(--tilePadding)] pb-4">
        <h1 className="text-[22px] font-normal leading-none text-[var(--text)]">Guest Portal</h1>
        <button
          type="button"
          onClick={onLogout}
          disabled={loggingOut}
          className="cursor-pointer rounded-full px-4 py-2 text-[14px] font-medium text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loggingOut ? 'Logging out...' : 'Log out'}
        </button>
      </header>

      <div className="px-[var(--tilePadding)] pb-[var(--tilePadding)]">
        <div
          data-testid="card-grid"
          className="grid max-w-5xl grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-[var(--tileGap)]"
        >
          {children}
        </div>
      </div>
    </div>
  )
}
