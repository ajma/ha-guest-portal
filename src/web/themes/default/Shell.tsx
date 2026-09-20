import type { ReactElement } from 'react'
import type { ShellProps } from '../types.js'

export function Shell({ children, onLogout, loggingOut }: ShellProps): ReactElement {
  return (
    <div
      data-testid="guest-screen"
      className="min-h-screen bg-[var(--appBg)] p-[var(--tilePadding)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-[var(--text)]">Guest Portal</h1>
        <button
          type="button"
          onClick={onLogout}
          disabled={loggingOut}
          className="px-4 py-2 text-sm font-medium text-[var(--text)] bg-[var(--surface)] border border-[var(--border)] rounded-[var(--tileRadius)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loggingOut ? 'Logging out...' : 'Log out'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-[var(--tileGap)] max-w-7xl">
        {children}
      </div>
    </div>
  )
}
