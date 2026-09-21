import * as mdi from '@mdi/js'
import type { ReactElement } from 'react'

const MDI_PREFIX = 'mdi:'

// "lightbulb-outline" -> "mdiLightbulbOutline", matching @mdi/js's export names
function toExportName(kebabName: string): string {
  const pascalName = kebabName
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return `mdi${pascalName}`
}

interface MdiIconProps {
  icon: string | null | undefined
}

// Home Assistant icons come as "mdi:icon-name". Anything that isn't a known
// @mdi/js export renders nothing rather than a placeholder glyph — a made-up
// stand-in icon would be a lie about what the entity actually reports.
export function MdiIcon({ icon }: MdiIconProps): ReactElement | null {
  if (icon == null || !icon.startsWith(MDI_PREFIX)) return null

  const name = icon.slice(MDI_PREFIX.length)
  const path = (mdi as Record<string, string | undefined>)[toExportName(name)]
  if (typeof path !== 'string') return null

  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  )
}
