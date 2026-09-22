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

/**
 * Throws rather than returning the default, so the return type is `string`.
 *
 * A required `portalId` parameter on `performAction` catches a dropped
 * argument, but not a dropped provider: with a `string | undefined` here, a
 * tile rendered outside the portal — a new theme with its own root, a second
 * route reusing `DeviceTile` — sends every admin action with no portal id and
 * takes a 400 on each one, behind a green typecheck and a green suite.
 */
export function usePortalId(): string {
  const portalId = useContext(PortalIdContext)
  if (portalId === undefined) {
    throw new Error('usePortalId: no PortalIdProvider — a tile must render inside a portal')
  }
  return portalId
}
