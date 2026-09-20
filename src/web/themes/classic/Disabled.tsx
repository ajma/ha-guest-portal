import type { ReactElement } from 'react'
import type { DisabledProps } from '../types.js'

/**
 * The copy here is verbatim from the default set — it must not read as an
 * error, and the two data-testid hooks are load-bearing for the e2e suite.
 */
export function Disabled({ onRetry }: DisabledProps): ReactElement {
  return (
    <div
      data-testid="portal-disabled-screen"
      className="flex flex-col items-center justify-center min-h-screen p-6 bg-[var(--appBg)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <div className="w-full max-w-sm p-6 text-center rounded-[var(--tileRadius)] bg-[var(--surface)] shadow-[var(--shadow)]">
        <h1 className="text-[22px] font-medium mb-3 text-[var(--text)]">
          The guest portal is currently unavailable
        </h1>
        <p className="text-[15px] text-[var(--textMuted)] mb-5">
          Your host has turned it off. It will come back on its own once they turn it back on — no
          need to sign in again.
        </p>
        <button
          type="button"
          data-testid="portal-disabled-retry"
          onClick={onRetry}
          className="py-[10px] px-5 text-sm font-medium uppercase tracking-wide rounded-[var(--tileRadius)] bg-[var(--accent)] text-[var(--accentText)] shadow-[var(--shadow)] cursor-pointer"
        >
          Check again
        </button>
      </div>
    </div>
  )
}
