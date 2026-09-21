import type { CSSProperties, ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { getDeploymentSettings } from '../api.js'

export type DeploymentSettingsPanelProps = {
  onClose: () => void
  onLogout: () => void
  loggingOut: boolean
}

const panel: CSSProperties = {
  backgroundColor: 'var(--surface)',
  color: 'var(--text)',
  fontFamily: 'var(--fontFamily)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
  padding: 'var(--tilePadding)',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
}

const header: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '12px',
}

const heading: CSSProperties = { fontSize: '16px', fontWeight: 600, margin: 0 }

const smallButton: CSSProperties = {
  padding: '6px 12px',
  fontSize: '13px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  backgroundColor: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

export function DeploymentSettingsPanel({
  onClose,
  onLogout,
  loggingOut,
}: DeploymentSettingsPanelProps): ReactElement {
  const [token, setToken] = useState<string>('')
  const [deploymentId, setDeploymentId] = useState<string>('')
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const result = await getDeploymentSettings()
    if (!result.ok) {
      setError('Failed to load deployment settings')
      return
    }
    setError(null)
    setToken(result.data.integrationToken)
    setDeploymentId(result.data.deploymentId)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section data-testid="deployment-settings-panel" aria-label="Settings" style={panel}>
      <div style={header}>
        <h2 style={heading}>Settings</h2>
        <button type="button" style={smallButton} onClick={onClose}>
          Close
        </button>
      </div>

      {error !== null && <p style={{ color: 'var(--danger)', fontSize: '13px' }}>{error}</p>}

      <div style={{ fontSize: '12px', color: 'var(--textMuted)' }}>
        <div style={{ marginBottom: '4px' }}>
          Integration token — used to set up the Home Assistant integration by hand. Add-on
          installations are discovered automatically.
        </div>
        {tokenRevealed ? (
          <code data-testid="integration-token" style={{ wordBreak: 'break-all', fontSize: '11px' }}>
            {token}
          </code>
        ) : (
          <button type="button" style={smallButton} onClick={() => setTokenRevealed(true)}>
            Show token
          </button>
        )}
        <div style={{ marginTop: '8px' }}>Deployment id: {deploymentId}</div>
      </div>

      <button
        type="button"
        style={smallButton}
        disabled={loggingOut}
        onClick={onLogout}
      >
        {loggingOut ? 'Logging out…' : 'Log out'}
      </button>
    </section>
  )
}
