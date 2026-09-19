import { useEffect, useState, useRef, type ReactElement } from 'react'
import type { Role } from '@shared/api.js'
import { getSession, setUnauthorizedCallback } from './api.js'
import { Admin } from './routes/Admin.js'
import { Guest } from './routes/Guest.js'
import { Login } from './routes/Login.js'
import { useDeviceStore } from './store.js'

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

  if (role === 'loading') {
    return <div>Loading...</div>
  }

  if (role === null) {
    return <Login onSuccess={handleLoginSuccess} />
  }

  // Routing logic
  const isAdminPath = window.location.pathname === '/admin'

  if (isAdminPath && role === 'admin') {
    return <Admin />
  }

  return <Guest />
}
