import type { CSSProperties, ReactElement } from 'react'
import { useState } from 'react'
import type { AllowlistRow } from '@shared/api.js'
import { DOMAIN_ACTIONS, parseDomain } from '@shared/devices.js'
import type { AllowlistEditor } from '../hooks/useAllowlistEditor.js'

export type TileEditorProps = {
  row: AllowlistRow
  editor: AllowlistEditor
  onClose: () => void
}

// Every colour, radius and font comes from the theme's CSS variables. This is
// not a theme component — it adds no slot to `Theme['components']`, so a new
// theme is still one token file — but it opens over a themed grid and would
// look pasted on if it carried its own palette.
const panel: CSSProperties = {
  backgroundColor: 'var(--surface)',
  color: 'var(--text)',
  fontFamily: 'var(--fontFamily)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
  padding: 'var(--tilePadding)',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
}

const header: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '12px',
}

const heading: CSSProperties = { fontSize: '16px', fontWeight: 600, margin: 0 }

const muted: CSSProperties = { fontSize: '12px', color: 'var(--textMuted)' }

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

const button: CSSProperties = {
  padding: '6px 12px',
  fontSize: '13px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  backgroundColor: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

const accentButton: CSSProperties = {
  ...button,
  color: 'var(--accent)',
  borderColor: 'var(--accent)',
}

const dangerButton: CSSProperties = {
  ...button,
  color: 'var(--danger)',
  borderColor: 'var(--danger)',
}

const buttonRow: CSSProperties = { display: 'flex', gap: '8px', flexWrap: 'wrap' }

const checkboxLabel: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  fontSize: '13px',
}

/**
 * Edits one device: rename, allowed actions, reorder, remove.
 *
 * Every control writes through `editor`, which saves immediately — there is no
 * Save button and nothing to commit on close. The one exception is the name
 * field, which keeps a local draft: the owner's keystrokes must survive a round
 * trip through the server and the SSE stream, and rendering the prop directly
 * would fight the cursor. Mount one editor per device (key it by entity id) so
 * the draft is seeded from the right row.
 */
export function TileEditor({ row, editor, onClose }: TileEditorProps): ReactElement {
  const [name, setName] = useState(row.label)
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const domain = parseDomain(row.entityId)
  // An unsupported domain has no actions to offer and no meaningful place in the
  // order — the tile renders inert. Naming and removing it still work.
  const actions: readonly string[] = domain === null ? [] : DOMAIN_ACTIONS[domain]
  const nameId = `tile-editor-label-${row.entityId}`

  return (
    <section data-testid="tile-editor" style={panel}>
      <div style={header}>
        <h2 style={heading}>{row.label}</h2>
        <button type="button" style={button} onClick={onClose}>
          Close
        </button>
      </div>

      <div>
        <label htmlFor={nameId} style={fieldLabel}>
          Name
        </label>
        <input
          id={nameId}
          type="text"
          value={name}
          style={textInput}
          onChange={(event) => {
            setName(event.target.value)
            editor.rename(row.entityId, event.target.value)
          }}
        />
        <div style={{ ...muted, marginTop: '4px' }}>{row.entityId}</div>
      </div>

      {domain !== null && (
        <div>
          <div style={fieldLabel}>Allowed actions</div>
          <div style={buttonRow}>
            {actions.map((action) => (
              <label key={action} style={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={row.allowedActions.includes(action)}
                  onChange={() => editor.toggleAction(row.entityId, action)}
                />
                <span>{action}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div style={buttonRow}>
        <button type="button" style={button} onClick={() => editor.move(row.entityId, -1)}>
          Move up
        </button>
        <button type="button" style={button} onClick={() => editor.move(row.entityId, 1)}>
          Move down
        </button>
      </div>

      {confirmingRemove ? (
        <div style={buttonRow}>
          {/* Removal is the only destructive edit here, and instant save means
              there is no unsaved state to back out of afterwards. */}
          <p style={{ ...muted, color: 'var(--text)', margin: 0, flexBasis: '100%' }}>
            Remove {row.label}?
          </p>
          <button
            type="button"
            style={dangerButton}
            onClick={() => {
              editor.remove(row.entityId)
              onClose()
            }}
          >
            Yes, remove
          </button>
          <button type="button" style={accentButton} onClick={() => setConfirmingRemove(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div style={buttonRow}>
          <button type="button" style={dangerButton} onClick={() => setConfirmingRemove(true)}>
            Remove
          </button>
        </div>
      )}

      {editor.error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: '13px', color: 'var(--danger)' }}>
          {editor.error}
        </p>
      )}
    </section>
  )
}
