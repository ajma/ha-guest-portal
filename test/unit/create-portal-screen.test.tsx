import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
