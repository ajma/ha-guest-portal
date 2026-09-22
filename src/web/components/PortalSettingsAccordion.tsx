import type { CSSProperties, ReactElement } from 'react'
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import type { PortalDetailResponse } from '@shared/api.js'
import { MAX_PORTAL_TITLE_LENGTH } from '@shared/portalTitle.js'
import { isThemeId, type ThemeId } from '@shared/themes.js'
import { deletePortal, getPortal, updatePortal } from '../api.js'
import { listThemes } from '../themes/registry.js'

type PortalDetail = z.infer<typeof PortalDetailResponse>

export type PortalSettingsAccordionProps = {
  portalId: string
  onUpdated: (portal: PortalDetail) => void
  onDeleted: () => void
}

const toggleButton: CSSProperties = {
  width: '100%',
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: '14px',
  fontWeight: 500,
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

const body: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  padding: '16px',
  marginTop: '8px',
  backgroundColor: 'var(--surface)',
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

const dangerButton: CSSProperties = {
  ...smallButton,
  color: 'var(--danger)',
  borderColor: 'var(--danger)',
}

const errorText: CSSProperties = { margin: 0, fontSize: '13px', color: 'var(--danger)' }

export function PortalSettingsAccordion({
  portalId,
  onUpdated,
  onDeleted,
}: PortalSettingsAccordionProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [portal, setPortal] = useState<PortalDetail | null>(null)
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const [passwordDraft, setPasswordDraft] = useState<string | null>(null)
  const [passwordRevealed, setPasswordRevealed] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [loadedFor, setLoadedFor] = useState(portalId)

  // Callers render this component without a key, so React keeps the same
  // instance across a portal switch. Dropping the loaded portal here is what
  // stops the previous portal's field values being saved onto the new one.
  // Done during render rather than in an effect so no click can land while
  // the old portal's values are still on screen.
  if (loadedFor !== portalId) {
    setLoadedFor(portalId)
    setPortal(null)
    setTitleDraft(null)
    setPasswordDraft(null)
    setConfirmingDelete(false)
    setPasswordRevealed(false)
    setError(null)
  }

  useEffect(() => {
    if (!expanded || portal !== null) return
    let cancelled = false

    async function load(): Promise<void> {
      const result = await getPortal(portalId)
      if (cancelled) return
      if (!result.ok) {
        setError('Could not load this portal')
        return
      }
      setPortal(result.data)
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [expanded, portal, portalId])

  async function applyPatch(patch: { title?: string; theme?: ThemeId; enabled?: boolean; password?: string }): Promise<void> {
    setError(null)
    const result = await updatePortal(portalId, patch)
    if (!result.ok) {
      setError(
        result.status === 409
          ? 'Could not save — that password is already in use'
          : 'Could not save that change',
      )
      return
    }
    setPortal(result.data)
    onUpdated(result.data)
  }

  function commitTitle(): void {
    if (titleDraft === null || portal === null || titleDraft === portal.title) {
      setTitleDraft(null)
      return
    }
    const next = titleDraft
    setTitleDraft(null)
    void applyPatch({ title: next })
  }

  function commitPassword(): void {
    if (passwordDraft === null || portal === null || passwordDraft === portal.password) {
      setPasswordDraft(null)
      return
    }
    const next = passwordDraft
    setPasswordDraft(null)
    void applyPatch({ password: next })
  }

  async function handleDelete(): Promise<void> {
    const result = await deletePortal(portalId)
    if (!result.ok) {
      setError('Could not delete this portal')
      return
    }
    onDeleted()
  }

  return (
    <div>
      <button
        type="button"
        style={toggleButton}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? '▾' : '▸'} Portal settings
      </button>

      {expanded && (
        <div style={body}>
          {portal === null ? (
            <p>Loading…</p>
          ) : (
            <>
              <div>
                <label htmlFor="portal-settings-title" style={fieldLabel}>
                  Portal name
                </label>
                <input
                  id="portal-settings-title"
                  type="text"
                  style={textInput}
                  value={titleDraft ?? portal.title}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitTitle}
                  maxLength={MAX_PORTAL_TITLE_LENGTH}
                />
              </div>

              <div role="radiogroup" aria-label="Theme" style={{ display: 'flex', gap: '12px' }}>
                {listThemes().map((theme) => (
                  <label key={theme.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input
                      type="radio"
                      name="portal-settings-theme"
                      checked={theme.id === portal.theme}
                      onChange={() => {
                        if (isThemeId(theme.id)) void applyPatch({ theme: theme.id })
                      }}
                    />
                    {theme.name}
                  </label>
                ))}
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={portal.enabled}
                  onChange={() => void applyPatch({ enabled: !portal.enabled })}
                />
                {portal.enabled ? 'Enabled — guests can log in' : 'Disabled — guests are blocked'}
              </label>

              <div>
                <label htmlFor="portal-settings-password" style={fieldLabel}>
                  Password
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    id="portal-settings-password"
                    type={passwordRevealed ? 'text' : 'password'}
                    style={textInput}
                    value={passwordDraft ?? portal.password}
                    onChange={(e) => setPasswordDraft(e.target.value)}
                    onBlur={commitPassword}
                  />
                  <button type="button" style={smallButton} onClick={() => setPasswordRevealed((r) => !r)}>
                    {passwordRevealed ? 'Hide password' : 'Show password'}
                  </button>
                </div>
              </div>

              {error !== null && (
                <p role="alert" style={errorText}>
                  {error}
                </p>
              )}

              {confirmingDelete ? (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span style={{ fontSize: '13px' }}>Delete this portal and its device list?</span>
                  <button
                    type="button"
                    style={dangerButton}
                    onClick={() => {
                      void handleDelete()
                    }}
                  >
                    Confirm delete
                  </button>
                  <button type="button" style={smallButton} onClick={() => setConfirmingDelete(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" style={dangerButton} onClick={() => setConfirmingDelete(true)}>
                  Delete portal
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
