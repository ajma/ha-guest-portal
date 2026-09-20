import { useCallback, useEffect, useState, useRef, type ReactElement } from 'react'
import type { Role } from '@shared/api.js'
import { getSession, logout, setUnauthorizedCallback } from './api.js'
import { Portal } from './routes/Portal.js'
import { setPortalEnabled, useDeviceStore } from './store.js'
import { activeTheme, componentsFor } from './themes/active.js'

export function App(): ReactElement {
  // Every screen App owns comes from the active theme, so nobody crosses an
  // unthemed seam. There is one portal: an owner gets Edit and Settings inside
  // it, rather than a separate page that looks nothing like what they ship.
  const { Login, Disabled } = componentsFor(activeTheme())
  const [role, setRole] = useState<Role | null | 'loading'>('loading')
  const { connected, portalEnabled } = useDeviceStore()
  const prevConnectedRef = useRef<boolean>(false)

  // Register unauthorized callback on mount
  useEffect(() => {
    setUnauthorizedCallback(() => {
      setRole(null)
    })

    return () => {
      setUnauthorizedCallback(null)
    }
  }, [])

  // Check session on mount
  useEffect(() => {
    async function checkSession(): Promise<void> {
      const session = await getSession()
      setRole(session?.role ?? null)
      if (session !== null) {
        setPortalEnabled(session.portalEnabled)
      }
    }

    void checkSession()
  }, [])

  // Re-check session when stream disconnects (only on transition from true to false)
  useEffect(() => {
    const wasConnected = prevConnectedRef.current
    prevConnectedRef.current = connected

    if (wasConnected && !connected && role !== 'loading' && role !== null) {
      async function recheckSession(): Promise<void> {
        const session = await getSession()
        if (session === null) {
          setRole(null)
          return
        }
        setPortalEnabled(session.portalEnabled)
      }

      void recheckSession()
    }
  }, [connected, role])

  const recheckPortal = useCallback(async (): Promise<void> => {
    const session = await getSession()
    if (session === null) {
      setRole(null)
      return
    }
    setPortalEnabled(session.portalEnabled)
  }, [])

  // While a guest is looking at the disabled screen their stream is closed, so
  // nothing will tell them the portal came back. Poll until it does.
  useEffect(() => {
    if (portalEnabled || role !== 'guest') return

    const timer = setInterval(() => {
      void recheckPortal()
    }, 15_000)

    return () => {
      clearInterval(timer)
    }
  }, [portalEnabled, role, recheckPortal])

  function handleLoginSuccess(newRole: Role): void {
    setRole(newRole)
  }

  async function handleLogout(): Promise<void> {
    await logout()
    setRole(null)
  }

  if (role === 'loading') {
    return <div>Loading...</div>
  }

  if (role === null) {
    return <Login onSuccess={handleLoginSuccess} />
  }

  if (role === 'guest' && !portalEnabled) {
    return (
      <Disabled
        onRetry={() => {
          void recheckPortal()
        }}
      />
    )
  }

  return <Portal role={role} onLogout={handleLogout} />
}
