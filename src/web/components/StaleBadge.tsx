import type { ReactElement } from 'react'

export function StaleBadge(): ReactElement {
  return (
    <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
      Not connected to Home Assistant
    </div>
  )
}
