import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as api from '../../src/web/api.js'
import { DeploymentSettingsPanel } from '../../src/web/components/DeploymentSettingsPanel.js'

vi.mock('../../src/web/api.js')

describe('DeploymentSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getDeploymentSettings).mockResolvedValue({
      ok: true,
      data: { integrationToken: 'abc123', deploymentId: 'dep-1' },
    })
  })

  afterEach(() => cleanup())

  it('reveals the integration token on click, masked by default', async () => {
    const user = userEvent.setup()
    render(<DeploymentSettingsPanel onClose={vi.fn()} onLogout={vi.fn()} loggingOut={false} />)

    expect(screen.queryByText('abc123')).toBeNull()
    await user.click(await screen.findByRole('button', { name: /show token/i }))
    expect(screen.getByText('abc123')).toBeTruthy()
  })

  it('calls onLogout when Log out is clicked', async () => {
    const user = userEvent.setup()
    const onLogout = vi.fn()
    render(<DeploymentSettingsPanel onClose={vi.fn()} onLogout={onLogout} loggingOut={false} />)

    await user.click(screen.getByRole('button', { name: /log out/i }))
    expect(onLogout).toHaveBeenCalled()
  })

  it('calls onClose when Close is clicked', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<DeploymentSettingsPanel onClose={onClose} onLogout={vi.fn()} loggingOut={false} />)

    await user.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
