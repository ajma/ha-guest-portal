import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PortalDropdown } from '../../src/web/components/PortalDropdown.js'

const PORTALS = [
  { id: 'p1', title: 'Timothy', theme: 'classic' as const, enabled: true },
  { id: 'p2', title: 'Mary', theme: 'tiles' as const, enabled: true },
]

describe('PortalDropdown', () => {
  afterEach(() => cleanup())

  it('lists every portal and the current selection', () => {
    render(<PortalDropdown portals={PORTALS} selectedId="p2" onSelect={vi.fn()} onAddPortal={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: /portal/i })
    expect((select as HTMLSelectElement).value).toBe('p2')
    expect(screen.getByRole('option', { name: 'Timothy' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Mary' })).toBeTruthy()
  })

  it('calls onSelect when switching to another portal', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<PortalDropdown portals={PORTALS} selectedId="p2" onSelect={onSelect} onAddPortal={vi.fn()} />)

    await user.selectOptions(screen.getByRole('combobox', { name: /portal/i }), 'Timothy')

    expect(onSelect).toHaveBeenCalledWith('p1')
  })

  it('calls onAddPortal, not onSelect, when choosing the trailing option', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onAddPortal = vi.fn()
    render(<PortalDropdown portals={PORTALS} selectedId="p2" onSelect={onSelect} onAddPortal={onAddPortal} />)

    await user.selectOptions(screen.getByRole('combobox', { name: /portal/i }), '+ Add portal')

    expect(onAddPortal).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })
})
