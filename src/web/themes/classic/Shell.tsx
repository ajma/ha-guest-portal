import type { ReactElement } from 'react'
import type { ShellProps } from '../types.js'

/**
 * Home Assistant's app frame: a raised toolbar above a flat content area. This
 * is the one place `--surfaceRaised` earns its keep — the toolbar must read as
 * elevated above `--appBg` in both modes.
 */
export function Shell({
  children,
  onLogout,
  loggingOut,
  title,
  headerActions,
}: ShellProps): ReactElement {
  return (
    <div
      data-testid="guest-screen"
      className="min-h-screen bg-[var(--appBg)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <header className="flex justify-between items-center px-[var(--tilePadding)] py-3 bg-[var(--surfaceRaised)] shadow-[var(--shadow)]">
        <h1 className="text-xl font-medium text-[var(--text)]">{title}</h1>
        <div className="flex items-center gap-2">
          {headerActions}
          <button
            type="button"
            onClick={onLogout}
            disabled={loggingOut}
            className="px-4 py-2 text-sm font-medium rounded-[var(--tileRadius)] text-[var(--text)] bg-[var(--surfaceActive)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loggingOut ? 'Logging out...' : 'Log out'}
          </button>
        </div>
      </header>

      <div className="p-[var(--tilePadding)]">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-[var(--tileGap)] max-w-7xl">
          {children}
        </div>
      </div>
    </div>
  )
}
