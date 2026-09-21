import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { mdiLightbulbOutline } from '@mdi/js'
import { MdiIcon } from '../../src/web/components/MdiIcon.tsx'

describe('MdiIcon', () => {
  afterEach(() => {
    cleanup()
  })

  it('converts a kebab-case mdi name to its @mdi/js path', () => {
    const { container } = render(<MdiIcon icon="mdi:lightbulb-outline" />)

    const path = container.querySelector('path')
    expect(path?.getAttribute('d')).toBe(mdiLightbulbOutline)
  })

  it('renders nothing when icon is null', () => {
    const { container } = render(<MdiIcon icon={null} />)

    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when icon is undefined', () => {
    const { container } = render(<MdiIcon icon={undefined} />)

    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the name does not resolve to a known @mdi/js export', () => {
    const { container } = render(<MdiIcon icon="mdi:not-a-real-icon-name" />)

    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for a non-mdi icon prefix', () => {
    const { container } = render(<MdiIcon icon="hass:lightbulb" />)

    expect(container.firstChild).toBeNull()
  })
})
