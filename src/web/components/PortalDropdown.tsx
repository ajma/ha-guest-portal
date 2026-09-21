import type { CSSProperties, ReactElement } from 'react'
import type { z } from 'zod'
import type { PortalSummaryResponse } from '@shared/api.js'

// Derived from the same schema the server responds with (Task 8), rather than
// a second hand-written shape that could drift from it.
export type PortalSummary = z.infer<typeof PortalSummaryResponse>

export type PortalDropdownProps = {
  portals: PortalSummary[]
  selectedId: string
  onSelect: (id: string) => void
  onAddPortal: () => void
}

const ADD_PORTAL_VALUE = '__add_portal__'

const select: CSSProperties = {
  fontSize: '24px',
  fontWeight: 700,
  fontFamily: 'inherit',
  color: 'var(--text)',
  backgroundColor: 'transparent',
  border: 'none',
  cursor: 'pointer',
}

export function PortalDropdown({
  portals,
  selectedId,
  onSelect,
  onAddPortal,
}: PortalDropdownProps): ReactElement {
  return (
    <select
      aria-label="Portal"
      style={select}
      value={selectedId}
      onChange={(e) => {
        if (e.target.value === ADD_PORTAL_VALUE) {
          onAddPortal()
          return
        }
        onSelect(e.target.value)
      }}
    >
      {portals.map((portal) => (
        <option key={portal.id} value={portal.id}>
          {portal.title}
        </option>
      ))}
      <option value={ADD_PORTAL_VALUE}>+ Add portal</option>
    </select>
  )
}
