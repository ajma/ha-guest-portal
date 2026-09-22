import { createContext, useContext } from 'react'

/**
 * The portal whose devices are on screen.
 *
 * Every action goes to `/api/devices/:id/:action`, and an admin's portal can
 * only come from `?portalId=` — the server takes a guest's from their session
 * and answers an admin with 400 when the query is missing. The tile hooks that
 * make that call sit inside a *theme's* tile component, so threading a prop
 * would mean adding `portalId` to `TileProps`, the one type a new theme has to
 * implement. Context keeps the theme contract about rendering a device.
 */
const PortalIdContext = createContext<string | undefined>(undefined)

export const PortalIdProvider = PortalIdContext.Provider

export function usePortalId(): string | undefined {
  return useContext(PortalIdContext)
}
