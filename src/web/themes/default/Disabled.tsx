import type { ReactElement } from 'react'
import type { DisabledProps } from '../types.js'

export function Disabled({ onRetry }: DisabledProps): ReactElement {
  return (
    <div
      data-testid="portal-disabled-screen"
      className="flex flex-col items-center justify-center min-h-screen p-6 text-center bg-[var(--appBg)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <h1 className="text-[22px] font-semibold mb-3 text-[var(--text)]">
        The guest portal is currently unavailable
      </h1>
      <p className="text-[15px] text-[var(--textMuted)] max-w-[360px] mb-5">
        Your host has turned it off. It will come back on its own once they turn it back on — no
        need to sign in again.
      </p>
      <button
        type="button"
        data-testid="portal-disabled-retry"
        onClick={onRetry}
        className="py-[10px] px-5 text-sm font-semibold rounded-[4px] bg-[var(--accent)] text-[var(--accentText)] cursor-pointer"
      >
        Check again
      </button>
    </div>
  )
}
