import type { CSSProperties, ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { MAX_PORTAL_TITLE_LENGTH, normalizePortalTitle } from '@shared/portalTitle.js'
import * as api from '../api.js'
import { readPortalTitle, writePortalTitle } from '../portalTitle.js'

export type PortalTitleFieldProps = {
  /**
   * Called with the normalised title after a successful save, so the page
   * around this field can update its own header. Writing the attribute back is
   * not enough on its own: React does not re-render on a DOM attribute change.
   */
  onSaved?: ((title: string) => void) | undefined
}

// Colours, radius and font come from the theme's CSS variables, as with the
// other owner surfaces. This is not a theme component and adds no slot to
// `Theme['components']`.
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

const hint: CSSProperties = { marginTop: '4px', fontSize: '12px', color: 'var(--textMuted)' }

const errorText: CSSProperties = { marginTop: '4px', fontSize: '13px', color: 'var(--danger)' }

const FIELD_ID = 'portal-title-field'

/**
 * The portal name, as guests see it in the header and the browser tab.
 *
 * Two deliberate choices:
 *
 * It commits on blur and on Enter, never on a keystroke. A PUT per character
 * would hammer the server, and — worse — the responses could land out of order,
 * so a slow early one would overwrite a later one and the owner would watch
 * their name revert to a prefix of itself.
 *
 * It keeps a local draft rather than rendering server state directly. The value
 * round-trips through the server, so a purely prop-driven input fights the
 * cursor; `draft === null` means "no pending edit", which is also how a failed
 * save reverts — dropping the draft exposes the last known-good value again.
 */
export function PortalTitleField({ onSaved }: PortalTitleFieldProps): ReactElement {
  // Seeded from the injected attribute so the field is populated on first
  // paint, then replaced by the stored value once the fetch answers. The two
  // agree unless another session renamed the portal since this page loaded.
  const [committed, setCommitted] = useState(readPortalTitle())
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      try {
        const result = await api.getAdminPortal()
        if (cancelled) return
        if (!result.ok) {
          setError('Could not load the portal name')
          return
        }
        // The draft is left alone: the owner may already be typing, and an
        // arriving fetch must not overwrite what they have half-written.
        setCommitted(result.data.title)
      } catch {
        if (!cancelled) setError('Could not load the portal name')
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [])

  const commit = useCallback(
    async (next: string): Promise<void> => {
      // Focus moving away is not an edit. Writing anyway would make a blur
      // indistinguishable from a rename in the server's logs and in the tests.
      if (next === committed) {
        setDraft(null)
        return
      }

      setError(null)

      let saved = false
      try {
        const result = await api.putAdminTitle(next)
        saved = result.ok
      } catch {
        // No function in src/web/api.ts guards fetch, so an offline browser
        // rejects here. Unhandled, the field would revert with no explanation.
        saved = false
      }

      if (!saved) {
        setDraft(null)
        setError('Could not save the portal name')
        return
      }

      // The server stores the normalised value, so clearing the field visibly
      // snaps back to the default instead of appearing to save a blank.
      const normalized = normalizePortalTitle(next)
      setCommitted(normalized)
      setDraft(null)

      // The injected attribute is the whole page's source for the title, and
      // the server writes it once at page load. Left stale, the owner's own
      // header and browser tab keep the old name until they reload — which is
      // exactly the indirection this restructure exists to remove.
      writePortalTitle(normalized)
      onSaved?.(normalized)
    },
    [committed, onSaved],
  )

  function commitDraft(): void {
    if (draft === null) return
    void commit(draft)
  }

  return (
    <div>
      <label htmlFor={FIELD_ID} style={fieldLabel}>
        Portal name
      </label>
      <input
        id={FIELD_ID}
        type="text"
        value={draft ?? committed}
        maxLength={MAX_PORTAL_TITLE_LENGTH}
        style={textInput}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commitDraft()
          }
        }}
      />
      <div style={hint}>Shown in the portal header and the browser tab.</div>
      {error !== null && (
        <div data-testid="portal-title-error" role="alert" style={errorText}>
          {error}
        </div>
      )}
    </div>
  )
}
