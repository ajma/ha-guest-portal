import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PortalToggle } from '../../src/web/components/PortalToggle.tsx'
import * as api from '../../src/web/api.ts'

vi.mock('../../src/web/api.ts')

describe('PortalToggle', () => {
  beforeEach(() => {
    vi.mocked(api.getAdminPortal).mockResolvedValue({
      ok: true,
      data: {
        enabled: true,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
      },
    })
    vi.mocked(api.putAdminPortal).mockResolvedValue({ ok: true, data: undefined })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the portal as enabled', async () => {
    render(<PortalToggle />)

    await waitFor(() => {
      expect((screen.getByTestId('portal-toggle') as HTMLInputElement).checked).toBe(true)
    })
  })

  it('disables the portal on click, without a separate save', async () => {
    render(<PortalToggle />)
    await waitFor(() => screen.getByTestId('portal-toggle'))

    await userEvent.click(screen.getByTestId('portal-toggle'))

    expect(api.putAdminPortal).toHaveBeenCalledWith(false)
  })

  it('shows a banner while disabled', async () => {
    vi.mocked(api.getAdminPortal).mockResolvedValue({
      ok: true,
      data: {
        enabled: false,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
      },
    })

    render(<PortalToggle />)

    await waitFor(() => {
      expect(screen.getByTestId('portal-disabled-banner')).toBeTruthy()
    })
  })

  it('reverts the toggle when the save fails', async () => {
    vi.mocked(api.putAdminPortal).mockResolvedValue({ ok: false, status: 500 })
    render(<PortalToggle />)
    await waitFor(() => screen.getByTestId('portal-toggle'))

    await userEvent.click(screen.getByTestId('portal-toggle'))

    await waitFor(() => {
      expect((screen.getByTestId('portal-toggle') as HTMLInputElement).checked).toBe(true)
    })
    expect(screen.getByTestId('portal-toggle-error')).toBeTruthy()
  })

  it('hides the integration token until revealed', async () => {
    render(<PortalToggle />)
    await waitFor(() => screen.getByTestId('portal-toggle'))

    expect(screen.queryByText('a'.repeat(64))).toBeNull()

    await userEvent.click(screen.getByTestId('reveal-token'))

    expect(screen.getByTestId('integration-token').textContent).toBe('a'.repeat(64))
  })

  it('shows an error when the initial load fails', async () => {
    vi.mocked(api.getAdminPortal).mockResolvedValue({ ok: false, status: 500 })

    render(<PortalToggle />)

    await waitFor(() => {
      expect(screen.getByText('Failed to load portal state')).toBeTruthy()
    })
    expect(screen.queryByText('Loading portal state...')).toBeNull()
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()
  })

  it('successfully loads the toggle after clicking retry', async () => {
    vi.mocked(api.getAdminPortal).mockResolvedValueOnce({ ok: false, status: 500 })
    vi.mocked(api.getAdminPortal).mockResolvedValueOnce({
      ok: true,
      data: {
        enabled: true,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
      },
    })

    render(<PortalToggle />)

    await waitFor(() => screen.getByRole('button', { name: /retry/i }))

    await userEvent.click(screen.getByRole('button', { name: /retry/i }))

    await waitFor(() => {
      expect((screen.getByTestId('portal-toggle') as HTMLInputElement).checked).toBe(true)
    })
    expect(screen.queryByText('Failed to load portal state')).toBeNull()
  })

  it('reverts the toggle when enabling fails', async () => {
    vi.mocked(api.getAdminPortal).mockResolvedValue({
      ok: true,
      data: {
        enabled: false,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
      },
    })
    vi.mocked(api.putAdminPortal).mockResolvedValue({ ok: false, status: 500 })

    render(<PortalToggle />)
    await waitFor(() => screen.getByTestId('portal-toggle'))

    await userEvent.click(screen.getByTestId('portal-toggle'))

    await waitFor(() => {
      expect((screen.getByTestId('portal-toggle') as HTMLInputElement).checked).toBe(false)
    })
    expect(screen.getByTestId('portal-toggle-error')).toBeTruthy()
  })

  it('keeps retry button available after consecutive load failures', async () => {
    vi.mocked(api.getAdminPortal).mockResolvedValue({ ok: false, status: 500 })

    render(<PortalToggle />)

    await waitFor(() => screen.getByRole('button', { name: /retry/i }))
    expect(screen.getByText('Failed to load portal state')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /retry/i }))

    await waitFor(() => screen.getByRole('button', { name: /retry/i }))
    expect(screen.getByText('Failed to load portal state')).toBeTruthy()
  })

  it('refreshes toggle state on window focus', async () => {
    vi.mocked(api.getAdminPortal).mockResolvedValueOnce({
      ok: true,
      data: {
        enabled: true,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
      },
    })

    render(<PortalToggle />)

    await waitFor(() => {
      expect((screen.getByTestId('portal-toggle') as HTMLInputElement).checked).toBe(true)
    })
    expect(screen.queryByTestId('portal-disabled-banner')).toBeNull()

    // Change the mock to return disabled
    vi.mocked(api.getAdminPortal).mockResolvedValueOnce({
      ok: true,
      data: {
        enabled: false,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
      },
    })

    // Dispatch focus event
    window.dispatchEvent(new Event('focus'))

    await waitFor(() => {
      expect((screen.getByTestId('portal-toggle') as HTMLInputElement).checked).toBe(false)
    })
    expect(screen.getByTestId('portal-disabled-banner')).toBeTruthy()
  })
})
