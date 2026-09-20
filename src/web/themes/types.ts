import type { ComponentType, ReactElement } from 'react'
import type { Device, Role } from '@shared/api.js'
import type { ThemeId } from '@shared/themes.js'
import type { SupportedDomain } from '@shared/devices.js'
import type { ThemeTokens } from './tokens.js'

export type TileProps = { device: Device; disabled: boolean }
export type ShellProps = { children: ReactElement | ReactElement[]; onLogout: () => void; loggingOut: boolean }
export type LoginProps = { onSuccess: (role: Role) => void }
export type DisabledProps = { onRetry: () => void }

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
  }
}
