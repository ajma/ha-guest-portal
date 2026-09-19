import type { ReactElement } from 'react'

type PortalDisabledProps = {
  onRetry: () => void
}

export function PortalDisabled({ onRetry }: PortalDisabledProps): ReactElement {
  return (
    <div
      data-testid="portal-disabled-screen"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: '24px',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: '22px', fontWeight: 600, marginBottom: '12px' }}>
        The guest portal is currently unavailable
      </h1>
      <p style={{ fontSize: '15px', color: '#555', maxWidth: '360px', marginBottom: '20px' }}>
        Your host has turned it off. It will come back on its own once they turn it back on — no
        need to sign in again.
      </p>
      <button
        type="button"
        data-testid="portal-disabled-retry"
        onClick={onRetry}
        style={{
          padding: '10px 20px',
          fontSize: '14px',
          fontWeight: 600,
          backgroundColor: '#5cb85c',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
        }}
      >
        Check again
      </button>
    </div>
  )
}
