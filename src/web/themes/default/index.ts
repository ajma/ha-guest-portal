import type { Theme } from '../types.js'
import { CoverTile } from './CoverTile.js'
import { Disabled } from './Disabled.js'
import { LockTile } from './LockTile.js'
import { Login } from './Login.js'
import { Shell } from './Shell.js'
import { ToggleTile } from './ToggleTile.js'

export const DEFAULT_COMPONENTS: Required<NonNullable<Theme['components']>> = {
  Shell,
  ToggleTile,
  CoverTile,
  LockTile,
  Login,
  Disabled,
}
