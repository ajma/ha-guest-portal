import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MAX_PORTAL_TITLE_LENGTH } from '@shared/portalTitle.js'
import * as api from '../../src/web/api.js'
import { CreatePortalScreen } from '../../src/web/components/CreatePortalScreen.js'

vi.mock('../../src/web/api.js')

describe('CreatePortalScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(cleanup)

  it('creates a portal with the entered title and password', async () => {
    const user = userEvent.setup()
    const created = { id: 'p1', title: 'Timothy', theme: 'classic' as const, enabled: true, password: 'a-secret' }
    vi.mocked(api.createPortal).mockResolvedValue({ ok: true, data: created })
    const onCreated = vi.fn()

    render(<CreatePortalScreen onCreated={onCreated} />)

    await user.type(screen.getByLabelText(/portal name/i), 'Timothy')
    await user.type(screen.getByLabelText(/^password$/i), 'a-secret')
    await user.click(screen.getByRole('button', { name: /create/i }))

    await waitFor(() =>
      expect(api.createPortal).toHaveBeenCalledWith({ title: 'Timothy', password: 'a-secret' }),
    )
    expect(onCreated).toHaveBeenCalledWith(created)
  })

  it('the password field is masked by default and reveals on click', async () => {
    const user = userEvent.setup()
    render(<CreatePortalScreen onCreated={vi.fn()} />)

    const passwordField = screen.getByLabelText(/^password$/i)
    expect(passwordField.getAttribute('type')).toBe('password')

    await user.click(screen.getByRole('button', { name: /show password/i }))
    expect(passwordField.getAttribute('type')).toBe('text')
  })

  it('says how long a password has to be and will not send a shorter one', async () => {
    const user = userEvent.setup()
    render(<CreatePortalScreen onCreated={vi.fn()} />)

    expect(screen.getByText(/at least 8 characters/i)).toBeTruthy()

    await user.type(screen.getByLabelText(/portal name/i), 'Timothy')
    await user.type(screen.getByLabelText(/^password$/i), 'guest')

    expect((screen.getByRole('button', { name: /create portal/i }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    await user.click(screen.getByRole('button', { name: /create portal/i }))
    expect(api.createPortal).not.toHaveBeenCalled()
  })

  it('will not send a password that is only whitespace', async () => {
    // The length rule exists so a portal is not trivially guessable, and the
    // guard next to it already trims the title. Counting untrimmed characters
    // here makes eight spaces a password the owner can neither see nor retype.
    const user = userEvent.setup()
    render(<CreatePortalScreen onCreated={vi.fn()} />)

    await user.type(screen.getByLabelText(/portal name/i), 'Timothy')
    await user.type(screen.getByLabelText(/^password$/i), '        ')

    expect((screen.getByRole('button', { name: /create portal/i }) as HTMLButtonElement).disabled).toBe(
      true,
    )

    await user.click(screen.getByRole('button', { name: /create portal/i }))
    expect(api.createPortal).not.toHaveBeenCalled()
  })

  it('creates a portal with a padded password exactly as typed', async () => {
    // The mirror of the guard above, and of the same pair in the settings
    // accordion: the length rule is trimmed, the value is not. The title beside
    // it IS trimmed on the way out, so nothing but this test says the password
    // must not be — and a password silently trimmed here is one the owner can
    // never type back in.
    const user = userEvent.setup()
    const padded = '  spaced-out  '
    vi.mocked(api.createPortal).mockResolvedValue({
      ok: true,
      data: { id: 'p1', title: 'Timothy', theme: 'classic' as const, enabled: true, password: padded },
    })

    render(<CreatePortalScreen onCreated={vi.fn()} />)

    await user.type(screen.getByLabelText(/portal name/i), 'Timothy')
    await user.type(screen.getByLabelText(/^password$/i), padded)
    await user.click(screen.getByRole('button', { name: /create portal/i }))

    await waitFor(() =>
      expect(api.createPortal).toHaveBeenCalledWith({ title: 'Timothy', password: padded }),
    )
  })

  it('distinguishes a rejected name or password from a fault', async () => {
    const user = userEvent.setup()
    vi.mocked(api.createPortal).mockResolvedValue({ ok: false, status: 400 })

    render(<CreatePortalScreen onCreated={vi.fn()} />)
    await user.type(screen.getByLabelText(/portal name/i), 'Timothy')
    await user.type(screen.getByLabelText(/^password$/i), 'long-enough')
    await user.click(screen.getByRole('button', { name: /create portal/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/not allowed/i)
  })

  it('sends a trimmed title and stops one longer than the server accepts', async () => {
    const user = userEvent.setup()
    vi.mocked(api.createPortal).mockResolvedValue({
      ok: true,
      data: { id: 'p1', title: 'Timothy', theme: 'classic' as const, enabled: true, password: 'a-secret' },
    })

    render(<CreatePortalScreen onCreated={vi.fn()} />)

    const titleField = screen.getByLabelText(/portal name/i)
    expect(titleField.getAttribute('maxlength')).toBe(String(MAX_PORTAL_TITLE_LENGTH))

    await user.type(titleField, '  Timothy  ')
    await user.type(screen.getByLabelText(/^password$/i), 'a-secret')
    await user.click(screen.getByRole('button', { name: /create portal/i }))

    await waitFor(() =>
      expect(api.createPortal).toHaveBeenCalledWith({ title: 'Timothy', password: 'a-secret' }),
    )
  })

  it('shows a server error, e.g. a duplicate password, without crashing', async () => {
    const user = userEvent.setup()
    vi.mocked(api.createPortal).mockResolvedValue({ ok: false, status: 409 })

    render(<CreatePortalScreen onCreated={vi.fn()} />)
    await user.type(screen.getByLabelText(/portal name/i), 'Timothy')
    await user.type(screen.getByLabelText(/^password$/i), 'taken-pass')
    await user.click(screen.getByRole('button', { name: /create/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not create/i)
  })
})
