import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Disabled as PortalDisabled } from '../../src/web/themes/default/Disabled.tsx'

describe('PortalDisabled', () => {
  afterEach(() => {
    cleanup()
  })
  it('explains that the portal is unavailable', () => {
    render(<PortalDisabled onRetry={() => {}} />)

    expect(screen.getByTestId('portal-disabled-screen')).toBeTruthy()
  })

  it('does not blame the guest or mention an error', () => {
    render(<PortalDisabled onRetry={() => {}} />)

    const text = screen.getByTestId('portal-disabled-screen').textContent ?? ''
    expect(text.toLowerCase()).not.toContain('error')
    expect(text.toLowerCase()).not.toContain('forbidden')
  })

  it('calls onRetry when the retry button is pressed', async () => {
    const onRetry = vi.fn()
    render(<PortalDisabled onRetry={onRetry} />)

    await userEvent.click(screen.getByTestId('portal-disabled-retry'))

    expect(onRetry).toHaveBeenCalledOnce()
  })
})
