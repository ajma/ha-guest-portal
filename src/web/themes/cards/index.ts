import type { Theme } from '../types.js'
import { CoverTile } from './CoverTile.js'
import { Disabled } from './Disabled.js'
import { icon } from './icons.js'
import { LockTile } from './LockTile.js'
import { Login } from './Login.js'
import { Shell } from './Shell.js'
import { dark, light } from './tokens.js'
import { ToggleTile } from './ToggleTile.js'

const cards: Theme = {
  id: 'cards',
  name: 'Cards',
  tokens: { light, dark },
  icon,
  components: {
    Shell,
    ToggleTile,
    CoverTile,
    LockTile,
    Login,
    Disabled,
  },
}

export default cards
