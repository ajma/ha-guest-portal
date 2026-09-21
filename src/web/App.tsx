import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { z } from 'zod'
import type { PortalDetailResponse, SessionResponse } from '@shared/api.js'
import { getPortals, getSession, logout, putLastSelectedPortal, setUnauthorizedCallback } from './api.js'
import { CreatePortalScreen } from './components/CreatePortalScreen.js'
import { Portal } from './routes/Portal.js'
import { setPortalEnabled, useDeviceStore } from './store.js'
import { activeTheme, componentsFor } from './themes/active.js'
import type { PortalSummary } from './components/PortalDropdown.js'

type PortalDetail = z.infer<typeof PortalDetailResponse>
type Session = z.infer<typeof SessionResponse>

// Constants rather than `role="guest"` / `role="admin"` inline: Biome's
// useValidAriaRole reads a literal `role` attribute on any JSX element as an
// ARIA role, component or not (same workaround as portal-page.test.tsx).
const GUEST = 'guest'
const ADMIN = 'admin'

type AppState =
  | { kind: 'loading' }
  | { kind: 'unreachable' }
  | { kind: 'logged-out' }
  | { kind: 'guest'; session: Extract<Session, { role: 'guest' }> }
  | {
      kind: 'admin'
      portals: PortalSummary[]
      selectedPortalId: string | null
      addingPortal: boolean
    }

export function App(): ReactElement {
  // Every screen App owns comes from the active theme, so nobody crosses an
  // unthemed seam. There is one portal: an owner gets Edit and Settings inside
  // it, rather than a separate page that looks nothing like what they ship.
  const { Login, Disabled, Unreachable } = componentsFor(activeTheme())
  const [state, setState] = useState<AppState>({ kind: 'loading' })
  const { connected, portalEnabled } = useDeviceStore()
  const prevConnectedRef = useRef<boolean>(false)

  useEffect(() => {
    setUnauthorizedCallback(() => {
      setState({ kind: 'logged-out' })
    })
    return () => {
      setUnauthorizedCallback(null)
    }
  }, [])

  const loadAdminPortals = useCallback(async (): Promise<void> => {
    const result = await getPortals()
    if (!result.ok) {
      setState({ kind: 'unreachable' })
      return
    }

    const { portals, lastSelectedPortalId } = result.data
    const selected =
      lastSelectedPortalId !== null && portals.some((p) => p.id === lastSelectedPortalId)
        ? lastSelectedPortalId
        : (portals[0]?.id ?? null)

    setState({ kind: 'admin', portals, selectedPortalId: selected, addingPortal: false })
  }, [])

  const applySession = useCallback(
    (session: Session): void => {
      if (session.role === 'admin') {
        void loadAdminPortals()
        return
      }

      setPortalEnabled(session.portalEnabled)
      setState({ kind: 'guest', session })
    },
    [loadAdminPortals],
  )

  const checkSession = useCallback(async (): Promise<void> => {
    try {
      const session = await getSession()
      if (session === null) {
        setState({ kind: 'logged-out' })
        return
      }
      applySession(session)
    } catch {
      // A rejection is a network failure — no connection, DNS, refused. An
      // answered request that happens to be a 401 returns null above and means
      // something completely different: the portal is there and wants a
      // password. Conflating them shows a guest a login form that cannot work,
      // or worse, the spinner this used to hang on.
      setState({ kind: 'unreachable' })
    }
  }, [applySession])

  useEffect(() => {
    void checkSession()
  }, [checkSession])

  // Re-check session when stream disconnects (only on transition from true to false)
  useEffect(() => {
    const wasConnected = prevConnectedRef.current
    prevConnectedRef.current = connected

    if (!wasConnected || connected || state.kind !== 'guest') return

    async function recheckSession(): Promise<void> {
      try {
        const session = await getSession()
        if (session === null) {
          setState({ kind: 'logged-out' })
          return
        }
        if (session.role === 'guest') {
          setPortalEnabled(session.portalEnabled)
          setState({ kind: 'guest', session })
        }
      } catch {
        // Deliberately not `unreachable`. The guest is already looking at a
        // screen that tells the truth — the stream dropped, so the tiles are
        // disabled — and the stream reconnects on its own. Throwing them onto
        // a screen with a Retry button would make a five-second blip need a
        // tap. Caught all the same: an unhandled rejection is not a plan.
      }
    }

    void recheckSession()
  }, [connected, state])

  const recheckPortal = useCallback(async (): Promise<void> => {
    try {
      const session = await getSession()
      if (session === null) {
        setState({ kind: 'logged-out' })
        return
      }
      if (session.role === 'guest') {
        setPortalEnabled(session.portalEnabled)
        setState({ kind: 'guest', session })
      }
    } catch {
      // Same reasoning as the reconnect check: this one runs on a 15-second
      // timer behind the disabled screen, so a failed poll should leave that
      // screen alone and let the next tick try again. Swallowing it keeps the
      // console clean rather than filling it with a rejection every 15s.
    }
  }, [])

  // While a guest is looking at the disabled screen their stream is closed, so
  // nothing will tell them the portal came back. Poll until it does. Gated on
  // the live device-store value, not `state.session.portalEnabled` — the
  // store is what the server's 'portal' SSE frame updates in place (Task 14),
  // so it is the freshest signal available while still connected, and the one
  // the disabled-screen check below must agree with.
  useEffect(() => {
    if (state.kind !== 'guest' || portalEnabled) return

    const timer = setInterval(() => {
      void recheckPortal()
    }, 15_000)

    return () => clearInterval(timer)
  }, [state.kind, portalEnabled, recheckPortal])

  async function handleLoginSuccess(session: Session): Promise<void> {
    applySession(session)
  }

  async function handleLogout(): Promise<void> {
    await logout()
    setState({ kind: 'logged-out' })
  }

  function handleSelectPortal(portalId: string): void {
    if (state.kind !== 'admin') return
    setState({ ...state, selectedPortalId: portalId })
    void putLastSelectedPortal(portalId)
  }

  function handlePortalCreated(portal: PortalDetail): void {
    if (state.kind !== 'admin') return
    const nextPortals = [...state.portals, portal]
    setState({ ...state, portals: nextPortals, selectedPortalId: portal.id, addingPortal: false })
    void putLastSelectedPortal(portal.id)
  }

  function handlePortalUpdated(portal: PortalDetail): void {
    if (state.kind !== 'admin') return
    setState({
      ...state,
      portals: state.portals.map((p) => (p.id === portal.id ? portal : p)),
    })
  }

  function handlePortalDeleted(): void {
    if (state.kind !== 'admin') return
    void loadAdminPortals()
  }

  if (state.kind === 'loading') {
    return <div>Loading...</div>
  }

  if (state.kind === 'unreachable') {
    return (
      <Unreachable
        onRetry={() => {
          setState({ kind: 'loading' })
          void checkSession()
        }}
      />
    )
  }

  if (state.kind === 'logged-out') {
    return <Login onSuccess={(session: Session) => void handleLoginSuccess(session)} />
  }

  if (state.kind === 'guest') {
    // Live device-store value, not `state.session.portalEnabled`: an
    // actively-connected guest learns their portal was disabled from the
    // server's 'portal' SSE frame (Task 14) well before their stream is
    // dropped and any recheck of /api/session runs. Reading the stale
    // session-carried copy here would leave them on the enabled portal until
    // that fallback caught up.
    if (!portalEnabled) {
      return (
        <Disabled
          onRetry={() => {
            void recheckPortal()
          }}
        />
      )
    }

    return (
      <Portal
        role={GUEST}
        portalId={state.session.portalId}
        guestPortalTitle={state.session.portalTitle}
        onLogout={handleLogout}
      />
    )
  }

  // state.kind === 'admin'
  if (state.portals.length === 0 && !state.addingPortal) {
    return <CreatePortalScreen onCreated={handlePortalCreated} />
  }

  if (state.selectedPortalId === null) {
    // Should be unreachable once `portals.length > 0` (loadAdminPortals always
    // picks a selection when the list is non-empty), but the type is nullable
    // — fail toward the create screen rather than rendering Portal with an
    // impossible empty portalId.
    return <CreatePortalScreen onCreated={handlePortalCreated} />
  }

  return (
    <Portal
      role={ADMIN}
      portalId={state.selectedPortalId}
      onLogout={handleLogout}
      portals={state.portals}
      onSelectPortal={handleSelectPortal}
      onAddPortal={() => setState({ ...state, addingPortal: true })}
      addingPortal={state.addingPortal}
      onPortalCreated={handlePortalCreated}
      onCancelAddPortal={() => setState({ ...state, addingPortal: false })}
      onPortalUpdated={handlePortalUpdated}
      onPortalDeleted={handlePortalDeleted}
    />
  )
}
