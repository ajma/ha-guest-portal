import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import * as api from '../api.js'

export function PortalToggle(): ReactElement {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [token, setToken] = useState<string>('')
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const result = await api.getAdminPortal()
    if (!result.ok) {
      setError('Failed to load portal state')
      return
    }
    setError(null)
    setEnabled(result.data.enabled)
    setToken(result.data.integrationToken)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Refresh toggle state when the admin page regains focus. This handles the
  // case where an owner disables the portal from Home Assistant (the switch,
  // a dashboard, or an automation) while the admin page is open.
  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (!document.hidden) {
        void load()
      }
    }

    const handleFocus = (): void => {
      void load()
    }

    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [load])

  async function handleToggle(): Promise<void> {
    if (enabled === null || saving) return

    const next = !enabled

    // Apply immediately: a kill-switch that needs a second click to take
    // effect is a defect. Revert if the server refuses.
    setEnabled(next)
    setSaving(true)
    setError(null)

    const result = await api.putAdminPortal(next)
    setSaving(false)

    if (!result.ok) {
      setEnabled(!next)
      setError('Failed to update the portal. Try again.')
    }
  }

  if (enabled === null) {
    if (error !== null) {
      return (
        <section data-testid="portal-toggle-section" style={{ marginBottom: '24px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Guest Portal</h2>
          <p style={{ color: '#d9534f', fontWeight: 500 }}>{error}</p>
          <button
            type="button"
            onClick={load}
            style={{
              marginTop: '12px',
              padding: '8px 16px',
              fontSize: '14px',
              cursor: 'pointer',
              backgroundColor: '#5cb85c',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
            }}
          >
            Retry
          </button>
        </section>
      )
    }
    return <section data-testid="portal-toggle-section">Loading portal state...</section>
  }

  return (
    <section data-testid="portal-toggle-section" style={{ marginBottom: '24px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Guest Portal</h2>

      <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <input
          data-testid="portal-toggle"
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={() => {
            void handleToggle()
          }}
        />
        <span style={{ fontSize: '14px' }}>
          {enabled ? 'Enabled — guests can log in' : 'Disabled — guests are blocked'}
        </span>
      </label>

      {!enabled && (
        <div
          data-testid="portal-disabled-banner"
          style={{
            marginTop: '8px',
            padding: '8px 12px',
            fontSize: '13px',
            color: '#8a6d3b',
            backgroundColor: '#fcf8e3',
            border: '1px solid #faebcc',
            borderRadius: '4px',
          }}
        >
          The guest portal is off. Guests cannot log in and anyone already signed in has been
          blocked. This admin page is unaffected.
        </div>
      )}

      {error !== null && (
        <div
          data-testid="portal-toggle-error"
          style={{ marginTop: '8px', color: '#d9534f', fontSize: '13px' }}
        >
          {error}
        </div>
      )}

      <div style={{ marginTop: '12px', fontSize: '12px', color: '#666' }}>
        <div style={{ marginBottom: '4px' }}>
          Integration token — only needed to set up the Home Assistant integration by hand. Add-on
          installations are discovered automatically.
        </div>
        {tokenRevealed ? (
          <code
            data-testid="integration-token"
            style={{ wordBreak: 'break-all', fontSize: '11px' }}
          >
            {token}
          </code>
        ) : (
          <button
            type="button"
            data-testid="reveal-token"
            onClick={() => setTokenRevealed(true)}
            style={{ padding: '4px 8px', fontSize: '12px', cursor: 'pointer' }}
          >
            Show token
          </button>
        )}
      </div>
    </section>
  )
}
