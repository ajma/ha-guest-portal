import { useCallback, useEffect, useState, useRef, type ReactElement } from 'react'
import type { Role } from '@shared/api.js'
import { getSession, logout, setUnauthorizedCallback } from './api.js'
import { Admin } from './routes/Admin.js'
import { Guest } from './routes/Guest.js'
import { setPortalEnabled, useDeviceStore } from './store.js'
import { activeTheme, componentsFor } from './themes/active.js'
import { appPath } from './path.js'

export function App(): ReactElement {
  // The two guest-facing screens App owns come from the active theme, so a
  // guest never crosses an unthemed seam. The admin surface is deliberately
  // not themed.
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

  // Routing logic
  // In production, use appPath to handle base href properly
  // In test environment, fall back to pathname
  let currentPath = '/'
  if (window.location.href && document.baseURI) {
    try {
      currentPath = appPath(document.baseURI, window.location.href)
    } catch {
      // Invalid URLs - use pathname directly
      currentPath = window.location.pathname || '/'
    }
  } else {
    // Test environment without full location object
    currentPath = window.location.pathname || '/'
  }

  const isAdminPath = currentPath === '/admin'

  if (isAdminPath && role === 'admin') {
    return <Admin onLogout={handleLogout} />
  }

  return <Guest onLogout={handleLogout} />
}
