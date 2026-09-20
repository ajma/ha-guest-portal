import type { CSSProperties, ReactElement } from 'react'
import { PortalTitleField } from './PortalTitleField.js'
import { PortalToggle } from './PortalToggle.js'
import { ThemePicker } from './ThemePicker.js'

export type SettingsPanelProps = {
  onClose: () => void
}

// As with TileEditor: every colour, radius and font comes from the theme's CSS
// variables. The panel opens over a themed grid and would look pasted on if it
// carried its own palette, but it is not a theme component — it adds no slot to
// `Theme['components']`, so a new theme is still one token file.
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

const closeButton: CSSProperties = {
  padding: '6px 12px',
  fontSize: '13px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  backgroundColor: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

/**
 * The owner's settings: what the portal is called, how it looks, and whether it
 * is on at all.
 *
 * Each of the three controls saves itself immediately and owns its own loading
 * and failure states, so there is nothing to coordinate here and no Save
 * button. `ThemePicker` and `PortalToggle` each fetch `getAdminPortal()`
 * separately, as does `PortalTitleField`. That duplication is deliberate for
 * now: three small independent fetches when a panel opens are cheaper than a
 * shared provider, and each control already recovers from its own load failure.
 */
export function SettingsPanel({ onClose }: SettingsPanelProps): ReactElement {
  return (
    <section data-testid="settings-panel" aria-label="Settings" style={panel}>
      <div style={header}>
        <h2 style={heading}>Settings</h2>
        <button type="button" style={closeButton} onClick={onClose}>
          Close
        </button>
      </div>

      <PortalTitleField />
      <ThemePicker />
      <PortalToggle />
    </section>
  )
}
