import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../../src/web/api.js'
import { PortalSettingsAccordion } from '../../src/web/components/PortalSettingsAccordion.js'

vi.mock('../../src/web/api.js')

const PORTAL = { id: 'p1', title: 'Timothy', theme: 'classic' as const, enabled: true, password: 'orig-pass' }

describe('PortalSettingsAccordion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getPortal).mockResolvedValue({ ok: true, data: PORTAL })
  })

  afterEach(() => cleanup())

  it('starts collapsed, expands on click, and loads the portal', async () => {
    render(<PortalSettingsAccordion portalId="p1" onUpdated={vi.fn()} onDeleted={vi.fn()} />)

    expect(screen.queryByLabelText(/portal name/i)).toBeNull()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /portal settings/i }))

    expect(await screen.findByDisplayValue('Timothy')).toBeTruthy()
  })

  it('the password is masked by default and reveals on click', async () => {
    const user = userEvent.setup()
    render(<PortalSettingsAccordion portalId="p1" onUpdated={vi.fn()} onDeleted={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /portal settings/i }))

    const passwordField = await screen.findByLabelText(/^password$/i)
    expect(passwordField.getAttribute('type')).toBe('password')

    await user.click(screen.getByRole('button', { name: /show password/i }))
    expect(passwordField.getAttribute('type')).toBe('text')
  })

  it('saves a title change on blur', async () => {
    const user = userEvent.setup()
    vi.mocked(api.updatePortal).mockResolvedValue({ ok: true, data: { ...PORTAL, title: 'Tim' } })
    const onUpdated = vi.fn()

    render(<PortalSettingsAccordion portalId="p1" onUpdated={onUpdated} onDeleted={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /portal settings/i }))

    const field = await screen.findByLabelText(/portal name/i)
    await user.clear(field)
    await user.type(field, '  Tim  ')
    await user.tab()

    await waitFor(() => expect(api.updatePortal).toHaveBeenCalledWith('p1', { title: '  Tim  ' }))
    expect(onUpdated).toHaveBeenCalledWith({ ...PORTAL, title: 'Tim' })
    // The field ends up showing what the server stored. A draft still held
    // after a successful save shows the owner their own untrimmed text back
    // while the portal is called something else everywhere else.
    await waitFor(() => expect((field as HTMLInputElement).value).toBe('Tim'))
  })

  it('requires a confirm click before deleting', async () => {
    const user = userEvent.setup()
    vi.mocked(api.deletePortal).mockResolvedValue({ ok: true, data: undefined })
    const onDeleted = vi.fn()

    render(<PortalSettingsAccordion portalId="p1" onUpdated={vi.fn()} onDeleted={onDeleted} />)
    await user.click(screen.getByRole('button', { name: /portal settings/i }))
    await screen.findByDisplayValue('Timothy')

    await user.click(screen.getByRole('button', { name: /^delete portal$/i }))
    expect(api.deletePortal).not.toHaveBeenCalled()

    await user.click(await screen.findByRole('button', { name: /confirm delete/i }))
    await waitFor(() => expect(api.deletePortal).toHaveBeenCalledWith('p1'))
    expect(onDeleted).toHaveBeenCalled()
  })

  it('reloads when portalId changes, so edits never carry the old portal’s values', async () => {
    const user = userEvent.setup()
    const OTHER = {
      id: 'p2',
      title: 'Mary',
      theme: 'classic' as const,
      enabled: false,
      password: 'mary-pass',
    }
    vi.mocked(api.updatePortal).mockResolvedValue({ ok: true, data: { ...OTHER, enabled: true } })

    const { rerender } = render(
      <PortalSettingsAccordion portalId="p1" onUpdated={vi.fn()} onDeleted={vi.fn()} />,
    )
    await user.click(screen.getByRole('button', { name: /portal settings/i }))
    await screen.findByDisplayValue('Timothy')

    vi.mocked(api.getPortal).mockResolvedValue({ ok: true, data: OTHER })
    rerender(<PortalSettingsAccordion portalId="p2" onUpdated={vi.fn()} onDeleted={vi.fn()} />)

    await waitFor(() => expect(api.getPortal).toHaveBeenCalledWith('p2'))
    expect(await screen.findByDisplayValue('Mary')).toBeTruthy()

    // p2 is disabled, so toggling must enable it. Reading p1's still-loaded
    // state here would send enabled:false to p2 instead.
    await user.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(api.updatePortal).toHaveBeenCalledWith('p2', { enabled: true }))
    expect(api.updatePortal).not.toHaveBeenCalledWith('p1', expect.anything())
  })

  it('saves the theme the owner picks', async () => {
    const user = userEvent.setup()
    const saved = { ...PORTAL, theme: 'tiles' as const }
    vi.mocked(api.updatePortal).mockResolvedValue({ ok: true, data: saved })
    const onUpdated = vi.fn()

    render(<PortalSettingsAccordion portalId="p1" onUpdated={onUpdated} onDeleted={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /portal settings/i }))

    await user.click(await screen.findByRole('radio', { name: 'Tiles' }))

    await waitFor(() => expect(api.updatePortal).toHaveBeenCalledWith('p1', { theme: 'tiles' }))
    expect(onUpdated).toHaveBeenCalledWith(saved)
    expect((screen.getByRole('radio', { name: 'Tiles' }) as HTMLInputElement).checked).toBe(true)
  })

  it('ignores a save that lands after the owner switched portals', async () => {
    const user = userEvent.setup()
    const OTHER = {
      id: 'p2',
      title: 'Mary',
      theme: 'classic' as const,
      enabled: false,
      password: 'mary-pass',
    }
    let resolvePut!: (value: Awaited<ReturnType<typeof api.updatePortal>>) => void
    vi.mocked(api.updatePortal).mockReturnValue(
      new Promise((resolve) => {
        resolvePut = resolve
      }),
    )

    const { rerender } = render(
      <PortalSettingsAccordion portalId="p1" onUpdated={vi.fn()} onDeleted={vi.fn()} />,
    )
    await user.click(screen.getByRole('button', { name: /portal settings/i }))

    const passwordField = await screen.findByLabelText(/^password$/i)
    await user.clear(passwordField)
    await user.type(passwordField, 'new-pass')
    await user.tab()

    vi.mocked(api.getPortal).mockResolvedValue({ ok: true, data: OTHER })
    rerender(<PortalSettingsAccordion portalId="p2" onUpdated={vi.fn()} onDeleted={vi.fn()} />)
    await screen.findByDisplayValue('Mary')

    await act(async () => {
      resolvePut({ ok: true, data: { ...PORTAL, password: 'new-pass' } })
    })

    // p1's response repainting the panel would put Timothy's name and password
    // on screen under Mary's heading, and the next blur or tick would PUT them
    // to p2.
    expect(screen.queryByDisplayValue('Timothy')).toBeNull()
    expect(screen.getByDisplayValue('Mary')).toBeTruthy()
    expect(screen.getByDisplayValue('mary-pass')).toBeTruthy()
  })

  it('states the password rule, and keeps a too-short one in the field to be fixed', async () => {
    const user = userEvent.setup()

    render(<PortalSettingsAccordion portalId="p1" onUpdated={vi.fn()} onDeleted={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /portal settings/i }))

    const passwordField = await screen.findByLabelText(/^password$/i)
    expect(screen.getByText('At least 8 characters')).toBeTruthy()

    await user.clear(passwordField)
    await user.type(passwordField, 'guest')
    await user.tab()

    expect((await screen.findByRole('alert')).textContent).toMatch(/at least 8 characters/i)
    expect(api.updatePortal).not.toHaveBeenCalled()
    // Cleared instead, the rejected password vanishes and the old one comes
    // back, so the owner cannot see or correct what they typed.
    expect((passwordField as HTMLInputElement).value).toBe('guest')
  })

  it('distinguishes a rejected value from a fault', async () => {
    const user = userEvent.setup()
    vi.mocked(api.updatePortal).mockResolvedValue({ ok: false, status: 400 })

    render(<PortalSettingsAccordion portalId="p1" onUpdated={vi.fn()} onDeleted={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /portal settings/i }))

    const field = await screen.findByLabelText(/portal name/i)
    await user.clear(field)
    await user.type(field, 'Tim')
    await user.tab()

    expect((await screen.findByRole('alert')).textContent).toMatch(/not allowed/i)
    // And the refused name is still in the field to be corrected, rather than
    // the old one back as if nothing had been typed.
    expect((field as HTMLInputElement).value).toBe('Tim')
  })

  it('shows a duplicate-password error without crashing', async () => {
    const user = userEvent.setup()
    vi.mocked(api.updatePortal).mockResolvedValue({ ok: false, status: 409 })

    render(<PortalSettingsAccordion portalId="p1" onUpdated={vi.fn()} onDeleted={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /portal settings/i }))

    const passwordField = await screen.findByLabelText(/^password$/i)
    await user.clear(passwordField)
    await user.type(passwordField, 'taken-pass')
    await user.tab()

    expect((await screen.findByRole('alert')).textContent).toMatch(/already in use/i)
    // And the refused password is still there to be edited, rather than the old
    // one back in the field as if nothing had been typed.
    expect((passwordField as HTMLInputElement).value).toBe('taken-pass')
  })
})
