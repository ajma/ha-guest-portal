import { type FormEvent, type ReactElement, useState } from 'react'
import { login } from '../../api.js'
import type { LoginProps } from '../types.js'

/**
 * A single rounded card on `--appBg`, with the same corner radius as a tile so
 * the first screen already looks like the portal behind it. The copy and every
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
      <div className="w-full max-w-sm rounded-[var(--tileRadius)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
        <h1 className="text-center text-[26px] font-bold tracking-[-0.5px] text-[var(--text)]">
          HA Guest Portal
        </h1>
        <p className="mt-1 text-center text-[15px] text-[var(--textMuted)]">Sign in to continue</p>

        <form
          onSubmit={(event) => {
            void handleSubmit(event)
          }}
          className="mt-6 space-y-4"
        >
          <div>
            <label
              htmlFor="password"
              className="block text-[13px] font-medium text-[var(--textMuted)]"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={submitting}
              className="mt-1 block w-full rounded-[14px] bg-[var(--surfaceActive)] px-4 py-3 text-[17px] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
          </div>

          {error !== null && <p className="text-[13px] text-[var(--danger)]">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full justify-center rounded-[14px] bg-[var(--accent)] px-4 py-3 text-[17px] font-semibold text-[var(--accentText)] disabled:opacity-50"
          >
            {submitting ? 'Signing in...' : 'Log in'}
          </button>
        </form>
      </div>
    </div>
  )
}
