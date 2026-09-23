import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'
import type { z } from 'zod'
import type { PortalDetailResponse, SessionResponse } from '@shared/api.js'
import { DEFAULT_PORTAL_TITLE } from '@shared/portalTitle.js'
import type { ThemeId } from '@shared/themes.js'
import { getPortals, getSession, logout, putLastSelectedPortal, setUnauthorizedCallback } from './api.js'
import { CreatePortalScreen } from './components/CreatePortalScreen.js'
import { DeploymentSettingsPanel } from './components/DeploymentSettingsPanel.js'
import { Portal } from './routes/Portal.js'
import { setPortalEnabled, useDeviceStore } from './store.js'
import { componentsFor, readThemeId, writeThemeId } from './themes/active.js'
import { resolveTheme } from './themes/registry.js'
import type { PortalSummary } from './components/PortalDropdown.js'

type PortalDetail = z.infer<typeof PortalDetailResponse>
type Session = z.infer<typeof SessionResponse>

// Constants rather than `role="guest"` / `role="admin"` inline: Biome's
// useValidAriaRole reads a literal `role` attribute on any JSX element as an
// ARIA role, component or not (same workaround as portal-page.test.tsx).
const GUEST = 'guest'
const ADMIN = 'admin'

// Matches Portal's header buttons, which this screen has no access to and
// would look unlike if it invented its own.
const gearButton: CSSProperties = {
  padding: '8px 12px',
  fontSize: '14px',
  fontWeight: 500,
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

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
  const [state, setState] = useState<AppState>({ kind: 'loading' })
  const [loggingOut, setLoggingOut] = useState(false)
  const [showDeploymentSettings, setShowDeploymentSettings] = useState(false)
  const { connected, portalEnabled } = useDeviceStore()
  const prevConnectedRef = useRef<boolean>(false)
  const stateKindRef = useRef<AppState['kind']>(state.kind)

  // The theme id lives in React state, not the DOM: a guest's is on their
  // session, an admin's is on whichever portal is selected, and both can
  // change without a reload (switching portals, saving a new theme in
  // settings). `loading` / `logged-out` / `unreachable` have no themed data of
  // their own to read, so they fall back to whatever `data-theme` currently
  // holds -- which, now that the effect below can have already overwritten
  // it, is not always what the server injected at page load. Concretely: an
  // admin on p1/classic who switches to p2/cards and then logs out sees the
  // login screen in cards, not classic, because the switch already wrote
  // 'cards' onto <html>. That is correct, not a leak: `handleSelectPortal`
  // and the settings save both PUT the change to the server before this ever
  // renders, so a real reload lands on the same theme these branches already
  // show; a session-less reload of the login screen itself always gets
  // `DEFAULT_THEME_ID` from the server regardless of what was on screen a
  // moment before (`themeAndTitleFor`, src/server/app.ts:57). Routed through
  // `resolveTheme(...).id` rather than the raw attribute so the value handed
  // to a required, ThemeId-typed prop is always one `componentsFor` can
  // actually resolve, never a name from a theme that has since been removed.
  let themeId: ThemeId
  if (state.kind === 'guest') {
    themeId = state.session.portalTheme
  } else if (state.kind === 'admin') {
    const selected = state.portals.find((p) => p.id === state.selectedPortalId)
    themeId = selected?.theme ?? resolveTheme(readThemeId()).id
  } else {
    themeId = resolveTheme(readThemeId()).id
  }

  // The CSS half of the fix: `generated.css` keys every variable block off
  // `[data-theme='...']` on <html>, and the server only writes that attribute
  // once, at page load. Without this, a portal switch or a settings save can
  // change `themeId` above and still leave the page painted in the old
  // theme's colours.
  //
  // `useLayoutEffect`, not `useEffect`, and deliberately so: the component
  // swap below is synchronous with render, but a passive effect commits after
  // the browser paints. A portal switch would then paint one real frame of
  // the new theme's Shell markup dressed in the old theme's CSS variables --
  // a colour flash on exactly the interaction this whole fix exists for.
  // `useLayoutEffect` runs after the DOM mutation and before paint, which
  // lines the two up. There is no SSR to warn about here: `src/web/main.tsx`
  // is a plain client `createRoot(...).render(...)`. No cleanup function on
  // purpose -- removing the attribute on unmount/re-run would fight
  // StrictMode's double-invoke, which unmounts and remounts effects once on
  // every render in development.
  useLayoutEffect(() => {
    writeThemeId(themeId)
  }, [themeId])

  // The tab title's sibling to `themeId` above: a guest's is on their
  // session, an admin's is on whichever portal is selected, and both can
  // change without a reload (switching portals, renaming in settings).
  // `null`, not a fallback name, for every other state -- see the effect
  // below for why.
  let pageTitle: string | null
  if (state.kind === 'guest') {
    pageTitle = state.session.portalTitle
  } else if (state.kind === 'admin') {
    const selected = state.portals.find((p) => p.id === state.selectedPortalId)
    pageTitle = selected?.title ?? DEFAULT_PORTAL_TITLE
  } else {
    pageTitle = null
  }

  // Unlike `writeThemeId` above, this is a plain `useEffect`, not
  // `useLayoutEffect`, and deliberately so: `data-theme` has to beat paint
  // because it drives the CSS variables the page is painted with, but
  // `document.title` is browser chrome that paints on its own schedule --
  // blocking the commit for it buys nothing.
  //
  // `null` means "do not write", not "write nothing in particular": the
  // `loading` / `logged-out` / `unreachable` states have no portal to name,
  // and resetting the tab there would clobber the server's correct
  // first-paint title the instant this effect first runs -- `loading` runs
  // before `getSession()` has even resolved. Consequence, accepted: an owner
  // who switches to "Cabin" and then logs out keeps "Cabin" in the tab until
  // the next reload, same as the theme above.
  useEffect(() => {
    if (pageTitle === null) return
    document.title = pageTitle
  }, [pageTitle])

  // Every screen App owns comes from the active theme, so nobody crosses an
  // unthemed seam. There is one portal: an owner gets Edit and Settings inside
  // it, rather than a separate page that looks nothing like what they ship.
  const { Login, Disabled, Unreachable, Shell } = componentsFor(resolveTheme(themeId))

  useEffect(() => {
    stateKindRef.current = state.kind
  }, [state.kind])

  useEffect(() => {
    setUnauthorizedCallback(() => {
      setState({ kind: 'logged-out' })
    })
    return () => {
      setUnauthorizedCallback(null)
    }
  }, [])

  const loadAdminPortals = useCallback(async (): Promise<void> => {
    try {
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
    } catch {
      // Same reasoning as checkSession, and the same screen: this runs
      // detached with `void`, outside that try, so a transport failure or an
      // unparseable body would otherwise be an unhandled rejection that leaves
      // the admin on "Loading..." with nothing to press.
      setState({ kind: 'unreachable' })
    }
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
    setLoggingOut(true)
    await logout()
    setLoggingOut(false)
    setState({ kind: 'logged-out' })
  }

  // Every one of these transitions is built from `prev`, never from the
  // `state` of the render that created the handler. `handlePortalUpdated` is
  // reached after an awaited PUT, so its closure can be several states out of
  // date by the time it runs: spreading it put back an `addingPortal: false`
  // that unmounted a half-typed create form, and a `selectedPortalId` the
  // owner had already moved on from. The `kind` guard lives inside the updater
  // for the same reason — read outside, it is as stale as the rest.
  function handleSelectPortal(portalId: string): void {
    setState((prev) => (prev.kind === 'admin' ? { ...prev, selectedPortalId: portalId } : prev))
    void putLastSelectedPortal(portalId)
  }

  function handlePortalCreated(portal: PortalDetail): void {
    setState((prev) =>
      prev.kind === 'admin'
        ? {
            ...prev,
            portals: [...prev.portals, portal],
            selectedPortalId: portal.id,
            addingPortal: false,
          }
        : prev,
    )
    void putLastSelectedPortal(portal.id)
  }

  function handlePortalUpdated(portal: PortalDetail): void {
    setState((prev) =>
      prev.kind === 'admin'
        ? { ...prev, portals: prev.portals.map((p) => (p.id === portal.id ? portal : p)) }
        : prev,
    )
  }

  // The only one of these that cannot guard inside an updater: it starts a
  // fetch, not a transition, and StrictMode would run it twice in there. It
  // needs the guard all the same — the delete is awaited, so a 401 can land
  // between the click and this callback, and reloading the portal list from
  // the login screen puts the owner back on a portal the server just refused.
  function handlePortalDeleted(): void {
    if (stateKindRef.current !== 'admin') return
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
        theme={themeId}
        onLogout={handleLogout}
      />
    )
  }

  // state.kind === 'admin'
  //
  // The null selection should be unreachable once `portals.length > 0`
  // (loadAdminPortals always picks a selection when the list is non-empty), but
  // the type is nullable — fail toward the create screen rather than rendering
  // Portal with an impossible empty portalId.
  //
  // In a Shell, because this screen is where a self-hosted admin lands on their
  // first login: bare, it has no logout and no way to reach the integration
  // token they need to pair the Home Assistant integration, and clearing the
  // cookie is the only way off it. The title is the deployment default — there
  // is no portal yet to name it.
  if (state.portals.length === 0 || state.selectedPortalId === null) {
    return (
      <Shell
        title={DEFAULT_PORTAL_TITLE}
        loggingOut={loggingOut}
        onLogout={() => {
          void handleLogout()
        }}
        headerActions={
          <button
            type="button"
            aria-label="Settings"
            style={gearButton}
            onClick={() => setShowDeploymentSettings(true)}
          >
            ⚙
          </button>
        }
      >
        {showDeploymentSettings ? (
          <DeploymentSettingsPanel
            onClose={() => setShowDeploymentSettings(false)}
            onLogout={() => {
              void handleLogout()
            }}
            loggingOut={loggingOut}
          />
        ) : (
          <CreatePortalScreen onCreated={handlePortalCreated} />
        )}
      </Shell>
    )
  }

  return (
    <Portal
      role={ADMIN}
      portalId={state.selectedPortalId}
      theme={themeId}
      onLogout={handleLogout}
      portals={state.portals}
      onSelectPortal={handleSelectPortal}
      onAddPortal={() =>
        setState((prev) => (prev.kind === 'admin' ? { ...prev, addingPortal: true } : prev))
      }
      addingPortal={state.addingPortal}
      onPortalCreated={handlePortalCreated}
      onCancelAddPortal={() =>
        setState((prev) => (prev.kind === 'admin' ? { ...prev, addingPortal: false } : prev))
      }
      onPortalUpdated={handlePortalUpdated}
      onPortalDeleted={handlePortalDeleted}
    />
  )
}
