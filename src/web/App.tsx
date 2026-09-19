import { useEffect, useState, useRef, type ReactElement } from 'react'
import type { Role } from '@shared/api.js'
import { getSession, logout, setUnauthorizedCallback } from './api.js'
import { Admin } from './routes/Admin.js'
import { Guest } from './routes/Guest.js'
import { Login } from './routes/Login.js'
import { useDeviceStore } from './store.js'
import { appPath } from './path.js'

export function App(): ReactElement {
  const [role, setRole] = useState<Role | null | 'loading'>('loading')
  const { connected } = useDeviceStore()
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
        }
      }

      void recheckSession()
    }
  }, [connected, role])

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
