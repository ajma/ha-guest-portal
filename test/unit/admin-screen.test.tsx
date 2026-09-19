import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Admin } from '../../src/web/routes/Admin.tsx'
import * as api from '../../src/web/api.ts'
import type { AllowlistRow, CatalogEntry } from '@shared/api.ts'

describe('Admin Screen', () => {
  const mockCatalog: CatalogEntry[] = [
    {
      entityId: 'light.porch',
      name: 'Porch Light',
      area: 'Front Yard',
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
      entityId: 'cover.garage',
      name: 'Garage Door',
      area: 'Garage',
      domain: 'cover',
      supported: true,
    },
  ]

  const getMockAllowlist = (): AllowlistRow[] => [
    {
      entityId: 'light.living_room',
      label: 'Living Room',
      allowedActions: ['turn_on', 'turn_off'],
      sortOrder: 0,
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    // Default mock for the PortalToggle component
    vi.spyOn(api, 'getAdminPortal').mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
      },
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('action checkboxes offer only the actions legal for that entity domain', async () => {
    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist').mockResolvedValue({
      ok: true,
      data: {
        devices: [
          {
            entityId: 'cover.garage',
            label: 'Garage',
            allowedActions: ['open_cover'],
            sortOrder: 0,
          },
        ],
        orphaned: [],
      },
    })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
    })

    // Cover domain should have open_cover, close_cover, stop_cover
    const openCheckbox = screen.getByRole('checkbox', { name: /open_cover/i })
    const closeCheckbox = screen.getByRole('checkbox', { name: /close_cover/i })
    const stopCheckbox = screen.getByRole('checkbox', { name: /stop_cover/i })

    expect(openCheckbox).toBeTruthy()
    expect(closeCheckbox).toBeTruthy()
    expect(stopCheckbox).toBeTruthy()

    // Should not have turn_on/turn_off (those are for light/switch/fan/input_boolean)
    expect(screen.queryByRole('checkbox', { name: /turn_on/i })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /turn_off/i })).toBeNull()
  })

  it('reorder up and down changes the order', async () => {
    const user = userEvent.setup()

    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist').mockResolvedValue({
      ok: true,
      data: {
        devices: [
          { entityId: 'light.first', label: 'First', allowedActions: ['turn_on'], sortOrder: 0 },
          { entityId: 'light.second', label: 'Second', allowedActions: ['turn_on'], sortOrder: 1 },
        ],
        orphaned: [],
      },
    })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
    })

    // Get all rows - check by entity IDs which are in the row text
    const rows = screen.getAllByTestId(/^allowlist-row-/)

    // First row should contain first entity
    expect(rows[0]?.textContent).toMatch(/light\.first/)
    expect(rows[1]?.textContent).toMatch(/light\.second/)

    // Click down button on first row
    const firstRow = rows[0]
    if (!firstRow) throw new Error('First row not found')
    const downButton = within(firstRow).getByRole('button', { name: /down/i })
    await user.click(downButton)

    // After reordering
    const reorderedRows = screen.getAllByTestId(/^allowlist-row-/)
    expect(reorderedRows[0]?.textContent).toMatch(/light\.second/)
    expect(reorderedRows[1]?.textContent).toMatch(/light\.first/)
  })

  it('remove button drops the row', async () => {
    const user = userEvent.setup()

    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist').mockResolvedValue({
      ok: true,
      data: {
        devices: getMockAllowlist(),
        orphaned: [],
      },
    })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
    })

    expect(screen.getByDisplayValue('Living Room')).toBeTruthy()

    const removeButton = screen.getByRole('button', { name: /remove/i })
    await user.click(removeButton)

    expect(screen.queryByDisplayValue('Living Room')).toBeNull()
  })

  it('orphaned row is visibly flagged', async () => {
    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist').mockResolvedValue({
      ok: true,
      data: {
        devices: getMockAllowlist(),
        orphaned: ['light.living_room'],
      },
    })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
    })

    // Should show some warning about orphaned device
    expect(screen.getByText(/orphaned|removed|renamed/i)).toBeTruthy()
  })

  it('500 from getAllowlist renders explanatory message', async () => {
    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist').mockResolvedValue({ ok: false, status: 500 })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.getByText(/home assistant.*reach|cannot.*reach/i)).toBeTruthy()
    })
  })

  it('Save calls putAllowlist and shows success', async () => {
    const user = userEvent.setup()

    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist').mockResolvedValue({
      ok: true,
      data: {
        devices: getMockAllowlist(),
        orphaned: [],
      },
    })
    const putSpy = vi.spyOn(api, 'putAllowlist').mockResolvedValue({ ok: true, data: undefined })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
    })

    const saveButton = screen.getByRole('button', { name: /save/i })
    await user.click(saveButton)

    expect(putSpy).toHaveBeenCalledOnce()
    await waitFor(() => {
      expect(screen.getByText(/success|saved/i)).toBeTruthy()
    })
  })

  it('400 from putAllowlist surfaces validation message', async () => {
    const user = userEvent.setup()

    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist').mockResolvedValue({
      ok: true,
      data: {
        devices: getMockAllowlist(),
        orphaned: [],
      },
    })
    vi.spyOn(api, 'putAllowlist').mockResolvedValue({ ok: false, status: 400 })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
    })

    const saveButton = screen.getByRole('button', { name: /save/i })
    await user.click(saveButton)

    await waitFor(() => {
      expect(screen.getByText(/failed|error|invalid/i)).toBeTruthy()
    })
  })

  it('adding entity via picker adds it to the list', async () => {
    const user = userEvent.setup()

    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist').mockResolvedValue({
      ok: true,
      data: {
        devices: [],
        orphaned: [],
      },
    })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
    })

    // Type in the entity picker
    const pickerInput = screen.getByRole('combobox')
    await user.type(pickerInput, 'porch')

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    // Should now see the Porch Light in the list (as input value)
    await waitFor(() => {
      expect(screen.getByDisplayValue('Porch Light')).toBeTruthy()
    })
  })

  it('editing label updates the device', async () => {
    const user = userEvent.setup()

    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist').mockResolvedValue({
      ok: true,
      data: {
        devices: getMockAllowlist(),
        orphaned: [],
      },
    })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
    })

    const labelInput = screen.getByDisplayValue('Living Room')
    expect(labelInput).toBeTruthy()

    await user.clear(labelInput)
    await user.type(labelInput, 'New Label')

    if (labelInput instanceof HTMLInputElement) {
      expect(labelInput.value).toBe('New Label')
    }
  })

  it('clicking Retry after 500 error re-calls getAllowlist', async () => {
    const user = userEvent.setup()

    const getCatalogSpy = vi.spyOn(api, 'getCatalog')
    getCatalogSpy.mockResolvedValue({ ok: true, data: mockCatalog })

    const getAllowlistSpy = vi.spyOn(api, 'getAllowlist')
    getAllowlistSpy.mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce({
      ok: true,
      data: { devices: getMockAllowlist(), orphaned: [] },
    })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.getByText(/cannot.*reach.*home assistant/i)).toBeTruthy()
    })

    expect(getAllowlistSpy).toHaveBeenCalledTimes(1)

    const retryButton = screen.getByRole('button', { name: /retry/i })
    await user.click(retryButton)

    await waitFor(() => {
      expect(screen.queryByText(/cannot.*reach/i)).toBeNull()
      expect(screen.queryByText(/loading/i)).toBeNull()
    })

    expect(getAllowlistSpy).toHaveBeenCalledTimes(2)

    await waitFor(() => {
      expect(screen.getByDisplayValue('Living Room')).toBeTruthy()
    })
  })

  it('Save sends the actual displayed order and labels', async () => {
    const user = userEvent.setup()

    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })

    const initialDevices = [
      { entityId: 'light.first', label: 'First', allowedActions: ['turn_on'], sortOrder: 0 },
      { entityId: 'light.second', label: 'Second', allowedActions: ['turn_off'], sortOrder: 1 },
      { entityId: 'light.third', label: 'Third', allowedActions: ['toggle'], sortOrder: 2 },
    ]

    vi.spyOn(api, 'getAllowlist').mockResolvedValue({
      ok: true,
      data: {
        devices: initialDevices,
        orphaned: [],
      },
    })

    const putSpy = vi.spyOn(api, 'putAllowlist').mockResolvedValue({ ok: true, data: undefined })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
    })

    // Move second down (second and third swap)
    const rows = screen.getAllByTestId(/^allowlist-row-/)
    const secondRow = rows[1]
    if (!secondRow) throw new Error('Second row not found')
    const downButton = within(secondRow).getByRole('button', { name: /down/i })
    await user.click(downButton)

    // Remove first row
    const firstRowAfterReorder = screen.getAllByTestId(/^allowlist-row-/)[0]
    if (!firstRowAfterReorder) throw new Error('First row not found after reorder')
    const removeButton = within(firstRowAfterReorder).getByRole('button', { name: /remove/i })
    await user.click(removeButton)

    // Edit label of remaining first row (was third)
    const labelInput = screen.getByDisplayValue('Third')
    await user.clear(labelInput)
    await user.type(labelInput, 'Edited Third')

    // Save
    const saveButton = screen.getByRole('button', { name: /save/i })
    await user.click(saveButton)

    await waitFor(() => {
      expect(putSpy).toHaveBeenCalledOnce()
    })

    const savedPayload = putSpy.mock.calls[0]?.[0]
    expect(savedPayload).toBeTruthy()
    if (!savedPayload) throw new Error('No payload sent')

    // Should have two devices (first removed)
    expect(savedPayload).toHaveLength(2)

    // First device should be Third (edited), sortOrder 0
    expect(savedPayload[0]).toEqual({
      entityId: 'light.third',
      label: 'Edited Third',
      allowedActions: ['toggle'],
      sortOrder: 0,
    })

    // Second device should be Second, sortOrder 1
    expect(savedPayload[1]).toEqual({
      entityId: 'light.second',
      label: 'Second',
      allowedActions: ['turn_off'],
      sortOrder: 1,
    })
  })

  it('re-fetches allowlist after successful save and adopts server-normalized values', async () => {
    const user = userEvent.setup()

    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist')
      .mockResolvedValueOnce({
        ok: true,
        data: {
          devices: [
            {
              entityId: 'light.test',
              label: '  Untrimmed  ',
              allowedActions: ['turn_on'],
              sortOrder: 0,
            },
          ],
          orphaned: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          devices: [
            {
              entityId: 'light.test',
              label: 'Untrimmed',
              allowedActions: ['turn_on'],
              sortOrder: 0,
            },
          ],
          orphaned: [],
        },
      })

    vi.spyOn(api, 'putAllowlist').mockResolvedValue({ ok: true, data: undefined })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
      const input = screen.getByDisplayValue((_content, element) => {
        return element instanceof HTMLInputElement && element.value === '  Untrimmed  '
      })
      expect(input).toBeTruthy()
    })

    const saveButton = screen.getByRole('button', { name: /save/i })
    await user.click(saveButton)

    await waitFor(() => {
      expect(screen.getByText(/success|saved/i)).toBeTruthy()
    })

    // Server-trimmed value should now be displayed
    expect(screen.getByDisplayValue('Untrimmed')).toBeTruthy()
    expect(screen.queryByDisplayValue('  Untrimmed  ')).toBeNull()
  })

  it('beforeunload is not registered initially', () => {
    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist').mockResolvedValue({
      ok: true,
      data: { devices: [], orphaned: [] },
    })

    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')

    render(<Admin onLogout={async () => {}} />)

    const beforeunloadCalls = addEventListenerSpy.mock.calls.filter(
      (call) => call[0] === 'beforeunload',
    )
    expect(beforeunloadCalls).toHaveLength(0)
  })

  it('beforeunload is registered after an edit', async () => {
    const user = userEvent.setup()

    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist').mockResolvedValue({
      ok: true,
      data: { devices: getMockAllowlist(), orphaned: [] },
    })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
    })

    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const initialCallCount = addEventListenerSpy.mock.calls.filter(
      (call) => call[0] === 'beforeunload',
    ).length

    // Make an edit
    const labelInput = screen.getByDisplayValue('Living Room')
    await user.type(labelInput, 'X')

    // Now beforeunload should be registered
    const afterEditCallCount = addEventListenerSpy.mock.calls.filter(
      (call) => call[0] === 'beforeunload',
    ).length
    expect(afterEditCallCount).toBeGreaterThan(initialCallCount)
  })

  it('beforeunload is removed after successful save', async () => {
    const user = userEvent.setup()

    vi.spyOn(api, 'getCatalog').mockResolvedValue({ ok: true, data: mockCatalog })
    vi.spyOn(api, 'getAllowlist').mockResolvedValue({
      ok: true,
      data: { devices: getMockAllowlist(), orphaned: [] },
    })
    vi.spyOn(api, 'putAllowlist').mockResolvedValue({ ok: true, data: undefined })

    render(<Admin onLogout={async () => {}} />)

    await waitFor(() => {
      expect(screen.queryByText(/loading/i)).toBeNull()
    })

    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const initialRemoveCount = removeEventListenerSpy.mock.calls.filter(
      (call) => call[0] === 'beforeunload',
    ).length

    // Make an edit
    const labelInput = screen.getByDisplayValue('Living Room')
    await user.type(labelInput, 'X')

    // Save
    const saveButton = screen.getByRole('button', { name: /save/i })
    await user.click(saveButton)

    await waitFor(() => {
      expect(screen.getByText(/success|saved/i)).toBeTruthy()
    })

    // beforeunload should be removed
    const afterSaveRemoveCount = removeEventListenerSpy.mock.calls.filter(
      (call) => call[0] === 'beforeunload',
    ).length
    expect(afterSaveRemoveCount).toBeGreaterThan(initialRemoveCount)
  })
})
