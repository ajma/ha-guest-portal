import { type FormEvent, type ReactElement, useState } from 'react'
import { login } from '../../api.js'
import type { LoginProps } from '../types.js'

/**
 * A centred card on `--appBg` with an `--accent` submit button. The copy and the
 * error branches are the default set's verbatim — only the visual language
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

      onSuccess(result.data.role)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-[var(--tilePadding)] bg-[var(--appBg)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <div className="w-full max-w-sm p-6 rounded-[var(--tileRadius)] bg-[var(--surface)] shadow-[var(--shadow)]">
        <h1 className="text-2xl font-medium text-center text-[var(--text)]">HA Guest Portal</h1>
        <p className="mt-2 text-center text-sm text-[var(--textMuted)]">Sign in to continue</p>

        <form
          onSubmit={(event) => {
            void handleSubmit(event)
          }}
          className="mt-6 space-y-4"
        >
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-[var(--text)]">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={submitting}
              className="mt-1 block w-full px-3 py-2 rounded-[var(--tileRadius)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>

          {error !== null && (
            <div className="rounded-[var(--tileRadius)] bg-[var(--surfaceActive)] p-3">
              <p className="text-sm text-[var(--danger)]">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex justify-center py-2 px-4 rounded-[var(--tileRadius)] text-sm font-medium uppercase tracking-wide text-[var(--accentText)] bg-[var(--accent)] shadow-[var(--shadow)] disabled:opacity-50"
          >
            {submitting ? 'Signing in...' : 'Log in'}
          </button>
        </form>
      </div>
    </div>
  )
}
