import { useState, type FormEvent, type ReactElement } from 'react'
import { login } from '../../api.js'
import type { LoginProps } from '../types.js'

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
      className="min-h-screen flex items-center justify-center bg-[var(--appBg)]"
      style={{ fontFamily: 'var(--fontFamily)' }}
    >
      <div className="max-w-md w-full space-y-8 p-[var(--tilePadding)]">
        <div>
          <h1 className="text-3xl font-bold text-center text-[var(--text)]">HA Guest Portal</h1>
          <p className="mt-2 text-center text-[var(--textMuted)]">Sign in to continue</p>
        </div>

        <form
          onSubmit={(event) => {
            void handleSubmit(event)
          }}
          className="mt-8 space-y-6"
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
              className="mt-1 block w-full px-3 py-2 border border-[var(--border)] rounded-[var(--tileRadius)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow)] focus:outline-none"
            />
          </div>

          {error !== null && (
            <div className="rounded-[var(--tileRadius)] bg-[var(--surfaceActive)] p-4">
              <p className="text-sm text-[var(--danger)]">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex justify-center py-2 px-4 rounded-[var(--tileRadius)] shadow-[var(--shadow)] text-sm font-medium text-[var(--accentText)] bg-[var(--accent)] disabled:opacity-50"
          >
            {submitting ? 'Signing in...' : 'Log in'}
          </button>
        </form>
      </div>
    </div>
  )
}
