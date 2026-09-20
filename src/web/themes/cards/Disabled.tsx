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
      className="flex min-h-screen flex-col items-center justify-center bg-[var(--appBg)] p-[var(--tilePadding)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <div className="w-full max-w-sm rounded-[var(--tileRadius)] bg-[var(--surface)] p-8 text-center">
        <h1 className="mb-3 text-[22px] font-normal text-[var(--text)]">
          The guest portal is currently unavailable
        </h1>
        <p className="mb-6 text-[14px] leading-[1.5] text-[var(--textMuted)]">
          Your host has turned it off. It will come back on its own once they turn it back on — no
          need to sign in again.
        </p>
        <button
          type="button"
          data-testid="portal-disabled-retry"
          onClick={onRetry}
          className="cursor-pointer rounded-full bg-[var(--accent)] px-6 py-3 text-[15px] font-medium text-[var(--accentText)]"
        >
          Check again
        </button>
      </div>
    </div>
  )
}
