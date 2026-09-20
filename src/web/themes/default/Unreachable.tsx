import type { ReactElement } from 'react'
import type { UnreachableProps } from '../types.js'

/**
 * Shown when the session request *rejected* — no connection, DNS failure,
 * connection refused. That is different from the portal answering "no session",
 * which is a login form, and different again from the owner switching the
 * portal off, which is `Disabled`.
 *
 * All we detect is that the portal did not answer, so the copy names the likely
 * cause without claiming to have measured it: the portal is reachable over a
 * VPN from anywhere, and unreachable from the sofa when the add-on is stopped.
 */
export function Unreachable({ onRetry }: UnreachableProps): ReactElement {
  return (
    <div
      data-testid="portal-unreachable-screen"
      className="flex flex-col items-center justify-center min-h-screen p-6 text-center bg-[var(--appBg)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <h1 className="text-[22px] font-semibold mb-3 text-[var(--text)]">
        Can&apos;t reach the guest portal
      </h1>
      <p className="text-[15px] text-[var(--textMuted)] max-w-[360px] mb-5">
        You may need to be on the home Wi-Fi. This screen also appears if the portal has been
        switched off at the router or the add-on is not running.
      </p>
      <button
        type="button"
        data-testid="portal-unreachable-retry"
        onClick={onRetry}
        className="py-[10px] px-5 text-sm font-semibold rounded-[4px] bg-[var(--accent)] text-[var(--accentText)] cursor-pointer"
      >
        Retry
      </button>
    </div>
  )
}
