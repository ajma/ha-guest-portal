import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
    await user.type(field, 'Tim')
    await user.tab()

    await waitFor(() => expect(api.updatePortal).toHaveBeenCalledWith('p1', { title: 'Tim' }))
    expect(onUpdated).toHaveBeenCalledWith({ ...PORTAL, title: 'Tim' })
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
  })
})
