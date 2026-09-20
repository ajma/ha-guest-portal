import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EntityPicker } from '../../src/web/components/EntityPicker.tsx'
import type { CatalogEntry } from '@shared/api.ts'

describe('EntityPicker', () => {
  const entities: CatalogEntry[] = [
    {
      entityId: 'light.porch',
      name: 'Porch Light',
      area: 'Front Yard',
      domain: 'light',
      supported: true,
    },
    {
      entityId: 'light.living_room',
      name: 'Living Room Lamp',
      area: 'Living Room',
      domain: 'light',
      supported: true,
    },
    {
      entityId: 'switch.kitchen',
      name: 'Kitchen Switch',
      area: null,
      domain: 'switch',
      supported: true,
    },
    {
      entityId: 'climate.upstairs',
      name: 'Upstairs Thermostat',
      area: 'Bedroom',
      domain: 'climate',
      supported: false,
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('typing porch matches by friendly name case-insensitively', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'porch')

    const listbox = screen.getByRole('listbox')
    const options = within(listbox).getAllByRole('option')

    expect(options).toHaveLength(1)
    expect(options[0]?.textContent).toMatch(/Porch Light/)
  })

  it('typing light.por matches by entity ID case-insensitively', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'light.por')

    const listbox = screen.getByRole('listbox')
    const options = within(listbox).getAllByRole('option')

    expect(options).toHaveLength(1)
    expect(options[0]?.textContent).toMatch(/Porch Light/)
  })

  it('matching is case-insensitive', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'PORCH')

    const listbox = screen.getByRole('listbox')
    const options = within(listbox).getAllByRole('option')

    expect(options).toHaveLength(1)
    expect(options[0]?.textContent).toMatch(/Porch Light/)
  })

  it('entities already on the allowlist are excluded from results', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={['light.porch']} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'light')

    const listbox = screen.getByRole('listbox')
    const options = within(listbox).getAllByRole('option')

    // Should show living_room but not porch
    expect(options.some((opt) => opt.textContent?.includes('Porch Light'))).toBe(false)
    expect(options.some((opt) => opt.textContent?.includes('Living Room Lamp'))).toBe(true)
  })

  it('never offers an unsupported entity, and gives no way to reveal one', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'thermostat')

    // There is exactly one unsupported entity in `entities` and it matches this
    // search by name, so an empty listbox is the filter working rather than the
    // search missing.
    expect(screen.queryByRole('listbox')).toBeNull()

    // There used to be a checkbox that revealed them. The portal cannot actuate
    // an unsupported entity, so revealing one only offered the owner a row that
    // could not be chosen — and on a real installation those rows were most of
    // the list. Its absence is the point of this assertion.
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('search returns only entities the portal can actuate', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'light')

    const listbox = screen.getByRole('listbox')
    const options = within(listbox).getAllByRole('option')

    // Should only show supported lights
    expect(options).toHaveLength(2)
    expect(options.some((opt) => opt.textContent?.includes('Porch Light'))).toBe(true)
    expect(options.some((opt) => opt.textContent?.includes('Living Room Lamp'))).toBe(true)
    expect(options.some((opt) => opt.textContent?.includes('Thermostat'))).toBe(false)
  })

  it('ArrowDown then Enter selects the first match', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'light')

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'light.porch',
      }),
    )
  })

  it('ArrowUp from the first option wraps to the last', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'light')

    // Move to first option
    await user.keyboard('{ArrowDown}')

    // Now press ArrowUp to wrap to last
    await user.keyboard('{ArrowUp}')
    await user.keyboard('{Enter}')

    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'light.living_room',
      }),
    )
  })

  it('ArrowDown from the last option wraps to the first', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'light')

    // Move to last option (ArrowDown twice)
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowDown}')

    // Now press ArrowDown to wrap to first
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'light.porch',
      }),
    )
  })

  it('Escape closes without selecting', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'light')

    screen.getByRole('listbox') // Verify it exists

    await user.keyboard('{Escape}')

    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Tab closes without selecting', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'light')

    screen.getByRole('listbox') // Verify it exists

    await user.tab()

    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('aria-activedescendant tracks the active option and matches option id', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'light')

    // Before arrow navigation, no active descendant
    expect(input.getAttribute('aria-activedescendant')).toBe('')

    await user.keyboard('{ArrowDown}')

    const activeDescendant = input.getAttribute('aria-activedescendant')
    expect(activeDescendant).toBeTruthy()

    // Find the option with that id
    if (!activeDescendant) throw new Error('activeDescendant not set')
    const activeOption = document.getElementById(activeDescendant)
    expect(activeOption).toBeTruthy()
    expect(activeOption?.textContent).toMatch(/Porch Light/)
  })

  it('the area subtitle renders and shows placeholder when area is null', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'kitchen')

    const listbox = screen.getByRole('listbox')
    const option = within(listbox).getByRole('option')

    expect(option.textContent).toMatch(/Kitchen Switch/)
    // Should show some placeholder for null area
    expect(option.textContent).toMatch(/no area/i)
  })

  it('shows entity ID as secondary text', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'porch')

    const listbox = screen.getByRole('listbox')
    const option = within(listbox).getByRole('option')

    expect(option.textContent).toMatch(/light\.porch/)
  })

  it('cannot select an unsupported entity with the keyboard, because it is never listed', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'thermostat')

    // Previously the row was rendered and guarded with aria-disabled. It is now
    // filtered out upstream, so there is nothing to arrow onto — a stronger
    // guarantee, and the reason this asserts on the listbox rather than on a
    // disabled option.
    expect(screen.queryByRole('listbox')).toBeNull()

    await user.keyboard('{ArrowDown}{Enter}')

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('clears input after successful selection', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'porch')

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    if (input instanceof HTMLInputElement) {
      expect(input.value).toBe('')
    }
  })

  it('clicking outside closes without selecting', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'light')

    screen.getByRole('listbox') // Verify it's open

    // Click outside
    await user.click(document.body)

    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('clicking an option still selects it despite click-outside handler', async () => {
    const user = userEvent.setup()

    const onSelect = vi.fn()
    render(<EntityPicker entities={entities} exclude={[]} onSelect={onSelect} />)

    const input = screen.getByRole('combobox')
    await user.type(input, 'porch')

    const listbox = screen.getByRole('listbox')
    const option = within(listbox).getByRole('option')

    await user.click(option)

    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'light.porch',
      }),
    )
  })
})
