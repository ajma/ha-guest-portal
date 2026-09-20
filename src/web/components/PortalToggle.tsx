import type { CSSProperties, ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import * as api from '../api.js'

// Colours, radius and font come from the theme's CSS variables. The kill switch
// now lives in the settings panel, over a themed page, so a palette of its own
// would read as pasted on. It is still not a theme component: it adds no slot
// to `Theme['components']`, and `test/unit/settings-panel.test.tsx` scans this
// file for literals.
const retryButton: CSSProperties = {
  marginTop: '12px',
  padding: '8px 16px',
  fontSize: '14px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  backgroundColor: 'var(--accent)',
  color: 'var(--accentText)',
  border: 'none',
  borderRadius: 'var(--tileRadius)',
}

// A native button would keep its user-agent chrome, which is the one surface a
// dark theme cannot reach.
const revealButton: CSSProperties = {
  padding: '4px 8px',
  fontSize: '12px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  backgroundColor: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

// The "portal is off" notice is a warning, and the token set has no warning
// role — --danger is the only alert colour a theme guarantees. Outlined rather
// than filled, so it reads as a notice rather than as an error that just
// happened, and so it needs no foreground token outside the set.
const disabledBanner: CSSProperties = {
  marginTop: '8px',
  padding: '8px 12px',
  fontSize: '13px',
  color: 'var(--danger)',
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--danger)',
  borderRadius: 'var(--tileRadius)',
}

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
          <p style={{ color: 'var(--danger)', fontWeight: 500 }}>{error}</p>
          <button type="button" onClick={load} style={retryButton}>
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
        <div data-testid="portal-disabled-banner" style={disabledBanner}>
          The guest portal is off. Guests cannot log in and anyone already signed in has been
          blocked. This admin page is unaffected.
        </div>
      )}

      {error !== null && (
        <div
          data-testid="portal-toggle-error"
          style={{ marginTop: '8px', color: 'var(--danger)', fontSize: '13px' }}
        >
          {error}
        </div>
      )}

      <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--textMuted)' }}>
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
            style={revealButton}
          >
            Show token
          </button>
        )}
      </div>
    </section>
  )
}
