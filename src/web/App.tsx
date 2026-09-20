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
  const { Login, Disabled, Unreachable } = componentsFor(activeTheme())
  const [role, setRole] = useState<Role | null | 'loading' | 'unreachable'>('loading')
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
  const checkSession = useCallback(async (): Promise<void> => {
    try {
      const session = await getSession()
      setRole(session?.role ?? null)
      if (session !== null) {
        setPortalEnabled(session.portalEnabled)
      }
    } catch {
      // A rejection is a network failure — no connection, DNS, refused. An
      // answered request that happens to be a 401 returns null above and means
      // something completely different: the portal is there and wants a
      // password. Conflating them shows a guest a login form that cannot work,
      // or worse, the spinner this used to hang on.
      setRole('unreachable')
    }
  }, [])

  useEffect(() => {
    void checkSession()
  }, [checkSession])

  // Re-check session when stream disconnects (only on transition from true to false)
  useEffect(() => {
    const wasConnected = prevConnectedRef.current
    prevConnectedRef.current = connected

    if (wasConnected && !connected && role !== 'loading' && role !== null) {
      async function recheckSession(): Promise<void> {
        try {
          const session = await getSession()
          if (session === null) {
            setRole(null)
            return
          }
          setPortalEnabled(session.portalEnabled)
        } catch {
          // Deliberately not `unreachable`. The guest is already looking at a
          // screen that tells the truth — the stream dropped, so the tiles are
          // disabled — and the stream reconnects on its own. Throwing them onto
          // a screen with a Retry button would make a five-second blip need a
          // tap. Caught all the same: an unhandled rejection is not a plan.
        }
      }

      void recheckSession()
    }
  }, [connected, role])

  const recheckPortal = useCallback(async (): Promise<void> => {
    try {
      const session = await getSession()
      if (session === null) {
        setRole(null)
        return
      }
      setPortalEnabled(session.portalEnabled)
    } catch {
      // Same reasoning as the reconnect check: this one runs on a 15-second
      // timer behind the disabled screen, so a failed poll should leave that
      // screen alone and let the next tick try again. Swallowing it keeps the
      // console clean rather than filling it with a rejection every 15s.
    }
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

  if (role === 'unreachable') {
    return (
      <Unreachable
        onRetry={() => {
          setRole('loading')
          void checkSession()
        }}
      />
    )
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
