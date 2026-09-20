import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { componentsFor } from '../../src/web/themes/active.ts'
import { DEFAULT_COMPONENTS } from '../../src/web/themes/default/index.ts'
import { listThemes } from '../../src/web/themes/registry.ts'

afterEach(() => {
  cleanup()
})

// Every theme's Shell, plus the default set, which a tokens-only theme uses.
// Built from the registry rather than a hardcoded list so a theme added later
// is covered without anyone remembering to add it here.
const shells: { id: string; Shell: typeof DEFAULT_COMPONENTS.Shell }[] = [
  { id: 'default', Shell: DEFAULT_COMPONENTS.Shell },
  ...listThemes().map((theme) => ({ id: theme.id, Shell: componentsFor(theme).Shell })),
]

describe('Shell contract', () => {
  it('covers every registered theme', () => {
    // Guards the loops below: an empty list would satisfy them vacuously.
    expect(shells.length).toBeGreaterThan(1)
  })

  for (const { id, Shell } of shells) {
    it(`${id}: renders the title it is given, not a hardcoded one`, () => {
      render(
        <Shell title="Beach House" onLogout={() => {}} loggingOut={false}>
          <div />
        </Shell>,
      )
      expect(screen.getByText('Beach House')).toBeTruthy()
      expect(screen.queryByText('Guest Portal')).toBeNull()
    })

    it(`${id}: renders headerActions when given them`, () => {
      render(
        <Shell
          title="Beach House"
          onLogout={() => {}}
          loggingOut={false}
          headerActions={<button type="button">Settings</button>}
        >
          <div />
        </Shell>,
      )
      // An owner who cannot reach this button cannot reach their settings.
      expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    })

    it(`${id}: renders nothing extra when headerActions is omitted`, () => {
      render(
        <Shell title="Beach House" onLogout={() => {}} loggingOut={false}>
          <div />
        </Shell>,
      )
      // A guest must not see an empty slot or a stray container.
      expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
    })
  }
})
