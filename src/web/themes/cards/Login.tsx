import { type FormEvent, type ReactElement, useState } from 'react'
import { login } from '../../api.js'
import type { LoginProps } from '../types.js'

/**
 * One card on a plain page, with the same corner radius as a device card so the
 * first screen already looks like the portal behind it. The copy and every
 * error branch are the default set's verbatim — only the visual language
 * changes between themes, never what the guest is told.
 */
export function Login({ onSuccess }: LoginProps): ReactElement {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      const result = await login(password)

      if (!result.ok) {
        if (result.status === 401) {
          setError('Invalid password. Please try again.')
        } else if (result.status === 429) {
          const seconds = 'retryAfter' in result ? result.retryAfter : 0
          setError(`Too many attempts. Please try again in ${seconds} seconds.`)
        } else {
          setError('Something went wrong. Please try again.')
        }
        return
      }

      onSuccess(result.data)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center bg-[var(--appBg)] p-[var(--tilePadding)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <div className="w-full max-w-sm rounded-[var(--tileRadius)] bg-[var(--surface)] p-8">
        <h1 className="text-center text-[24px] font-normal text-[var(--text)]">HA Guest Portal</h1>
        <p className="mt-2 text-center text-[14px] text-[var(--textMuted)]">Sign in to continue</p>

        <form
          onSubmit={(event) => {
            void handleSubmit(event)
          }}
          className="mt-8 space-y-5"
        >
          <div>
            <label
              htmlFor="password"
              className="block text-[12px] font-medium text-[var(--textMuted)]"
            >
              Password
            </label>
            {/* Material's filled field: no box, one line under it, and the
                accent taking that line over on focus. */}
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={submitting}
              className="mt-1 block w-full rounded-t-[8px] border-b-2 border-[var(--border)] bg-[var(--surfaceActive)] px-4 py-3 text-[16px] text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            />
          </div>

          {error !== null && <p className="text-[13px] text-[var(--danger)]">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full cursor-pointer justify-center rounded-full bg-[var(--accent)] px-6 py-3 text-[15px] font-medium text-[var(--accentText)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Signing in...' : 'Log in'}
          </button>
        </form>
      </div>
    </div>
  )
}
