import type { CSSProperties, ReactElement } from 'react'
import { useState } from 'react'
import type { z } from 'zod'
import type { PortalDetailResponse } from '@shared/api.js'
import { createPortal } from '../api.js'

type PortalDetail = z.infer<typeof PortalDetailResponse>

export type CreatePortalScreenProps = {
  onCreated: (portal: PortalDetail) => void
  /** Omitted for the full-page, zero-portal case — there is nothing to cancel back to. */
  onCancel?: () => void
}

const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  maxWidth: '360px',
  margin: '64px auto',
  padding: 'var(--tilePadding)',
  backgroundColor: 'var(--surface)',
  color: 'var(--text)',
  fontFamily: 'var(--fontFamily)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

const fieldLabel: CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 500,
  marginBottom: '4px',
  color: 'var(--textMuted)',
}

const textInput: CSSProperties = {
  width: '100%',
  padding: '8px',
  fontSize: '14px',
  fontFamily: 'inherit',
  color: 'var(--text)',
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

const passwordRow: CSSProperties = { display: 'flex', gap: '8px' }

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

const submitButton: CSSProperties = {
  padding: '10px 16px',
  fontSize: '14px',
  fontWeight: 500,
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--accentText)',
  backgroundColor: 'var(--accent)',
  border: 'none',
  borderRadius: 'var(--tileRadius)',
}

const errorText: CSSProperties = { margin: 0, fontSize: '13px', color: 'var(--danger)' }

const actionsRow: CSSProperties = { display: 'flex', gap: '8px' }

const cancelButton: CSSProperties = {
  padding: '10px 16px',
  fontSize: '14px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  backgroundColor: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

export function CreatePortalScreen({ onCreated, onCancel }: CreatePortalScreenProps): ReactElement {
  const [title, setTitle] = useState('')
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(): Promise<void> {
    setSubmitting(true)
    setError(null)

    let result: Awaited<ReturnType<typeof createPortal>>
    try {
      result = await createPortal({ title, password })
    } catch {
      setSubmitting(false)
      setError('Could not create the portal')
      return
    }

    setSubmitting(false)

    if (!result.ok) {
      setError(
        result.status === 409
          ? 'Could not create the portal — that password is already in use'
          : 'Could not create the portal',
      )
      return
    }

    onCreated(result.data)
  }

  return (
    <div style={wrap}>
      <h1 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>Create a portal</h1>

      <div>
        <label htmlFor="create-portal-title" style={fieldLabel}>
          Portal name
        </label>
        <input
          id="create-portal-title"
          type="text"
          style={textInput}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="create-portal-password" style={fieldLabel}>
          Password
        </label>
        <div style={passwordRow}>
          <input
            id="create-portal-password"
            type={revealed ? 'text' : 'password'}
            style={textInput}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            style={revealButton}
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? 'Hide password' : 'Show password'}
          </button>
        </div>
      </div>

      {error !== null && (
        <p role="alert" style={errorText}>
          {error}
        </p>
      )}

      <div style={actionsRow}>
        <button
          type="button"
          style={submitButton}
          disabled={submitting || title.trim() === '' || password.trim() === ''}
          onClick={() => {
            void handleSubmit()
          }}
        >
          {submitting ? 'Creating…' : 'Create portal'}
        </button>
        {onCancel !== undefined && (
          <button type="button" style={cancelButton} disabled={submitting} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
