import type { ComponentType, ReactElement } from 'react'
import type { Device, Role } from '@shared/api.js'
import type { ThemeId } from '@shared/themes.js'
import type { SupportedDomain } from '@shared/devices.js'
import type { ThemeTokens } from './tokens.js'

export type TileProps = { device: Device; disabled: boolean }
export type ShellProps = {
  children: ReactElement | ReactElement[]
  onLogout: () => void
  loggingOut: boolean
  /** The owner-configured portal name. Never hardcode a title in a Shell. */
  title: string
  /**
   * Owner-only controls (Edit, Settings), or undefined for a guest. A Shell
   * MUST render this when present — dropping it locks an owner out of their
   * own settings with no other visible symptom. `test/unit/shell-contract.test.tsx`
   * enforces it for every registered theme.
   */
  headerActions?: ReactElement
}
export type LoginProps = { onSuccess: (role: Role) => void }
export type DisabledProps = { onRetry: () => void }
/**
 * `Disabled` means the owner switched the portal off; `Unreachable` means we
 * could not ask. Different cause, different copy, so it is its own slot.
 */
export type UnreachableProps = { onRetry: () => void }

export type Theme = {
  id: ThemeId
  name: string
  tokens: { light: ThemeTokens; dark: ThemeTokens }
  icon: (domain: SupportedDomain, state: string) => ReactElement
  /**
   * Optional. A theme that supplies nothing here renders through the default
   * component set using its tokens alone — that is what keeps a new theme to
   * one token file rather than a component set.
   */
  components?: {
    Shell?: ComponentType<ShellProps>
    ToggleTile?: ComponentType<TileProps>
    CoverTile?: ComponentType<TileProps>
    LockTile?: ComponentType<TileProps>
    Login?: ComponentType<LoginProps>
    Disabled?: ComponentType<DisabledProps>
    Unreachable?: ComponentType<UnreachableProps>
  }
}
