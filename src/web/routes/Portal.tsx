import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import type { CatalogEntry, Device, Role } from '@shared/api.js'
import type { z } from 'zod'
import type { PortalDetailResponse } from '@shared/api.js'
import { getCatalog } from '../api.js'
import { CreatePortalScreen } from '../components/CreatePortalScreen.js'
import { DeploymentSettingsPanel } from '../components/DeploymentSettingsPanel.js'
import { EntityPicker } from '../components/EntityPicker.js'
import { PortalDropdown, type PortalSummary } from '../components/PortalDropdown.js'
import { PortalSettingsAccordion } from '../components/PortalSettingsAccordion.js'
import { TileEditor } from '../components/TileEditor.js'
import { useAllowlistEditor } from '../hooks/useAllowlistEditor.js'
import { PortalIdProvider } from '../portalContext.js'
import { connectDeviceStore, useDeviceStore } from '../store.js'
import { activeTheme, componentsFor } from '../themes/active.js'
import type { DEFAULT_COMPONENTS } from '../themes/default/index.js'

type PortalDetail = z.infer<typeof PortalDetailResponse>

type PortalProps = {
  role: Role
  portalId: string
  onLogout: () => Promise<void>
  /** Guest-only: their own portal's title, straight from their SessionResponse
   * (Task 8) — a guest is never given `portals`, so the title can't be looked
   * up the way the admin path looks it up. */
  guestPortalTitle?: string
  portals?: PortalSummary[]
  onSelectPortal?: (id: string) => void
  onAddPortal?: () => void
  addingPortal?: boolean
  onPortalCreated?: (portal: PortalDetail) => void
  onCancelAddPortal?: () => void
  onPortalUpdated?: (portal: PortalDetail) => void
  onPortalDeleted?: () => void
}

type Components = typeof DEFAULT_COMPONENTS

/** Edit is the only mode left — Settings is no longer mutually exclusive with
 * it, since the per-portal accordion is always visible and the deployment
 * panel is a plain boolean overlay. */
type Mode = 'normal' | 'edit'

// This page is themed, and the owner's chrome sits inside it — so every colour,
// radius and font here comes from the theme's CSS variables. A literal would be
// right in one theme and wrong in the other three, and wrong in dark mode.
const headerButton: CSSProperties = {
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

const headerButtonOn: CSSProperties = {
  ...headerButton,
  color: 'var(--accentText)',
  backgroundColor: 'var(--accent)',
  borderColor: 'var(--accent)',
}

const smallButton: CSSProperties = {
  padding: '6px 12px',
  fontSize: '13px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  backgroundColor: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
}

// Edit mode changes what a tap does, so it has to be unmistakable at a glance.
// The dashed accent frame marks every tile that is now an editing target.
const editWrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  padding: '6px',
  border: '2px dashed var(--accent)',
  borderRadius: 'var(--tileRadius)',
}

const orphanedWrap: CSSProperties = {
  ...editWrap,
  borderColor: 'var(--danger)',
}

const editWrapBar: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
}

const orphanFlag: CSSProperties = {
  margin: 0,
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--danger)',
}

const ghostButton: CSSProperties = {
  width: '100%',
  minHeight: '96px',
  padding: 'var(--tilePadding)',
  fontSize: '15px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  color: 'var(--textMuted)',
  backgroundColor: 'transparent',
  border: '2px dashed var(--border)',
  borderRadius: 'var(--tileRadius)',
}

const panel: CSSProperties = {
  backgroundColor: 'var(--surface)',
  color: 'var(--text)',
  fontFamily: 'var(--fontFamily)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
  padding: 'var(--tilePadding)',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
}

const panelHeader: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '12px',
}

const panelHeading: CSSProperties = { fontSize: '16px', fontWeight: 600, margin: 0 }

const mutedText: CSSProperties = { margin: 0, fontSize: '13px', color: 'var(--textMuted)' }

const errorText: CSSProperties = { margin: 0, fontSize: '13px', color: 'var(--danger)' }

// The overlays sit over the grid rather than in it, so the tiles behind them
// stay live — the stream does not pause because an editor is open.
const overlayBackdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '16px',
  backgroundColor: 'color-mix(in srgb, var(--appBg) 82%, transparent)',
}

const overlayInner: CSSProperties = {
  width: '100%',
  maxWidth: '520px',
  maxHeight: '100%',
  overflowY: 'auto',
}

// Settings is wider than the tile editor because it lays the three theme
// previews out side by side: at 520px each thumbnail is about 155px across,
// which is too small to tell the themes apart — and telling them apart is the
// entire job of that control. No media query needed: `width: 100%` and the
// backdrop's padding already bind on a phone, so raising the cap only has an
// effect once there is a desktop-sized viewport to spend.
const settingsInner: CSSProperties = {
  ...overlayInner,
  maxWidth: '880px',
}

// The picker gets more room again. Settings and the tile editor are forms;
// this is a search over every entity in the house, and the ghost tile exists
// only to open it.
//
// Height is deliberately *not* set here, only inherited as `maxHeight: 100%`.
// The result list is `flex: 1 1 auto`, so a fixed height does not permit a
// tall dialog, it compels one: a search matching a single entity used to
// render as a near-fullscreen panel of empty white. The list carries its own
// floor instead, so the dialog grows with the results and stops there.
const pickerInner: CSSProperties = {
  ...overlayInner,
  maxWidth: '720px',
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'visible',
}

const modeBanner: CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: '16px',
  transform: 'translateX(-50%)',
  zIndex: 40,
  padding: '8px 16px',
  fontSize: '14px',
  fontFamily: 'var(--fontFamily)',
  color: 'var(--accentText)',
  backgroundColor: 'var(--accent)',
  borderRadius: 'var(--tileRadius)',
  boxShadow: 'var(--shadow)',
}

/**
 * Declared at module scope, not inside `Portal`. A component defined during
 * render is a new type on every render, which remounts the whole grid and
 * throws away each tile's optimistic state.
 */
function DeviceTile({
  device,
  disabled,
  components,
}: {
  device: Device
  disabled: boolean
  components: Components
}): ReactElement {
  const { ToggleTile, CoverTile, LockTile } = components
  const domain = device.domain

  if (domain === 'light' || domain === 'switch' || domain === 'fan' || domain === 'input_boolean') {
    return <ToggleTile device={device} disabled={disabled} />
  }

  if (domain === 'cover') {
    return <CoverTile device={device} disabled={disabled} />
  }

  if (domain === 'lock') {
    return <LockTile device={device} disabled={disabled} />
  }

  // Unreachable in practice: the picker only offers domains with a tile, and
  // the server rejects an action on anything else. Rendering the label rather
  // than a complaint about it keeps a stray row legible instead of alarming.
  return <div>{device.label}</div>
}

/**
 * A tile in edit mode: the same themed tile, wrapped so a tap edits it.
 *
 * Module-scoped for the same reason as `DeviceTile`.
 *
 * The click is intercepted in the CAPTURE phase, so it never reaches the
 * theme's tile button — in edit mode a tap on a light opens its editor rather
 * than switching the light on. The explicit Edit button is the keyboard and
 * screen-reader affordance, and the only way in for a tile with no actions
 * allowed, which renders as inert text with nothing to focus.
 */
function EditableTile({
  device,
  components,
  orphaned,
  onEdit,
}: {
  device: Device
  components: Components
  orphaned: boolean
  onEdit: (entityId: string) => void
}): ReactElement {
  return (
    <div
      data-entity-id={device.entityId}
      style={orphaned ? orphanedWrap : editWrap}
      onClickCapture={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onEdit(device.entityId)
      }}
    >
      <div style={editWrapBar}>
        <button
          type="button"
          style={smallButton}
          aria-label={`Edit ${device.label}`}
          onClick={() => {
            onEdit(device.entityId)
          }}
        >
          Edit
        </button>
      </div>
      {orphaned && (
        <p style={orphanFlag}>⚠ Orphaned: entity was renamed or removed in Home Assistant</p>
      )}
      {/*
        Not `disabled` by the stream's connection state here: the tile is not
        actuated in edit mode anyway, and a disabled button swallows the click
        that opens the editor, so a disconnected owner could not edit at all.
      */}
      <DeviceTile device={device} disabled={false} components={components} />
    </div>
  )
}

export function Portal({
  role,
  portalId,
  onLogout,
  guestPortalTitle,
  portals,
  onSelectPortal,
  onAddPortal,
  addingPortal,
  onPortalCreated,
  onCancelAddPortal,
  onPortalUpdated,
  onPortalDeleted,
}: PortalProps): ReactElement {
  const [loggingOut, setLoggingOut] = useState(false)
  const [mode, setMode] = useState<Mode>('normal')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [showDeploymentSettings, setShowDeploymentSettings] = useState(false)
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [shownPortalId, setShownPortalId] = useState(portalId)

  // Same render-phase reset as the allowlist editor, for the same reason: App
  // re-renders this page with a new `portalId` rather than remounting it, so
  // every piece of edit state survives the switch. Dropping them in an effect
  // instead would commit one render in which the open editor shows the
  // previous portal's device under the new portal's heading.
  //
  // Which is why this is a comment and not a test: React Testing Library
  // flushes effects before anything can assert, so the tests below pass either
  // way and the single bad commit is invisible to them. Moving this into a
  // `useEffect` will look safe and green. It is not.
  if (shownPortalId !== portalId) {
    setShownPortalId(portalId)
    show('normal')
  }

  // Connect to the device store for the current portal on mount, and
  // reconnect whenever the admin switches to a different portal.
  useEffect(() => {
    const teardown = connectDeviceStore(portalId)
    return teardown
  }, [portalId])

  const { devices, connected } = useDeviceStore()
  const isOwner = role === 'admin'
  // The allowlist fetch lives in the editor: it needs the same response, both
  // for the orphan flags and as the list its whole-list PUTs are computed from.
  // `connected` goes with `devices` because an empty list means opposite things
  // with the stream up and down.
  const editor = useAllowlistEditor(devices, portalId, isOwner && mode === 'edit', connected)

  const components = componentsFor(activeTheme())
  const { Shell } = components

  const loadCatalog = useCallback(async (): Promise<void> => {
    setCatalogFailed(false)
    try {
      const result = await getCatalog()
      if (!result.ok) {
        setCatalogFailed(true)
        return
      }
      setCatalog(result.data)
    } catch {
      setCatalogFailed(true)
    }
  }, [])

  // Also called during render by the portal-switch reset above, so it must stay
  // state-only — a side effect here would run twice under StrictMode.
  function show(next: Mode): void {
    setMode(next)
    setEditingId(null)
    setAdding(false)
  }

  const editingRow =
    editingId === null ? undefined : editor.rows.find((row) => row.entityId === editingId)

  const sortedDevices = [...devices].sort((a, b) => a.sortOrder - b.sortOrder)
  const tilesDisabled = !connected

  async function handleLogout(): Promise<void> {
    setLoggingOut(true)
    await onLogout()
  }

  function pickerBody(): ReactElement {
    if (catalogFailed) {
      return (
        <>
          <p style={errorText}>Could not load the device list</p>
          <div>
            <button type="button" style={smallButton} onClick={() => void loadCatalog()}>
              Retry
            </button>
          </div>
        </>
      )
    }

    if (catalog === null) {
      return <p style={mutedText}>Loading devices…</p>
    }

    return (
      <EntityPicker
        entities={catalog}
        exclude={editor.rows.map((row) => row.entityId)}
        onSelect={(entity) => {
          editor.add(entity)
          setAdding(false)
        }}
      />
    )
  }

  const children: ReactElement[] =
    sortedDevices.length === 0
      ? [
          <p key="__empty" className="text-[var(--textMuted)]">
            No devices available
          </p>,
        ]
      : sortedDevices.map((device) =>
          mode === 'edit' ? (
            <EditableTile
              key={device.entityId}
              device={device}
              components={components}
              orphaned={editor.orphaned.includes(device.entityId)}
              onEdit={setEditingId}
            />
          ) : (
            <DeviceTile
              key={device.entityId}
              device={device}
              disabled={tilesDisabled}
              components={components}
            />
          ),
        )

  if (mode === 'edit') {
    if (editor.loadFailed) {
      children.push(
        <div key="__orphan-error" style={panel}>
          <p style={errorText}>
            Could not check for orphaned devices — Home Assistant may be unreachable.
          </p>
          <div>
            <button type="button" style={smallButton} onClick={editor.reload}>
              Retry
            </button>
          </div>
        </div>,
      )
    }

    // The editor reports a refused or failed save, and the tile editor shows it
    // — but an edit made from the picker, or one refused before any tile could
    // be opened, has nowhere else to appear.
    if (editor.error !== null && editingRow === undefined) {
      children.push(
        <div key="__editor-error" style={panel}>
          <p role="alert" style={errorText}>
            {editor.error}
          </p>
          <div>
            <button type="button" style={smallButton} onClick={editor.dismissError}>
              Dismiss
            </button>
          </div>
        </div>,
      )
    }

    children.push(
      <div key="__ghost">
        <button
          type="button"
          style={ghostButton}
          disabled={!editor.ready}
          onClick={() => {
            setAdding(true)
            void loadCatalog()
          }}
        >
          + Add device
        </button>
        {!editor.ready && (
          <p style={mutedText}>Waiting for this portal’s device list before anything is saved</p>
        )}
      </div>,
    )

    children.push(
      <div key="__mode-banner" role="status" style={modeBanner}>
        Edit mode — tap a device to change it. Changes save as you make them.
      </div>,
    )
  }

  if (adding) {
    children.push(
      <div key="__overlay" data-testid="picker-overlay" style={overlayBackdrop}>
        <div style={pickerInner}>
          <section style={{ ...panel, flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
            <div style={panelHeader}>
              <h2 style={panelHeading}>Add a device</h2>
              <button type="button" style={smallButton} onClick={() => setAdding(false)}>
                Close
              </button>
            </div>
            {pickerBody()}
          </section>
        </div>
      </div>,
    )
  } else if (showDeploymentSettings) {
    children.push(
      <div key="__overlay" data-testid="settings-overlay" style={overlayBackdrop}>
        <div style={settingsInner}>
          <DeploymentSettingsPanel
            onClose={() => setShowDeploymentSettings(false)}
            onLogout={() => {
              void handleLogout()
            }}
            loggingOut={loggingOut}
          />
        </div>
      </div>,
    )
  } else if (addingPortal === true) {
    children.push(
      <div key="__overlay" data-testid="add-portal-overlay" style={overlayBackdrop}>
        <div style={overlayInner}>
          <CreatePortalScreen
            onCreated={(portal) => {
              // onPortalCreated's own handler already closes this overlay
              // (addingPortal: false) as part of the same state update that
              // adds the portal and selects it. A second setState here,
              // built from this render's now-stale `state` closure, would
              // overwrite that update and revert the portal list.
              onPortalCreated?.(portal)
            }}
            {...(onCancelAddPortal !== undefined && { onCancel: onCancelAddPortal })}
          />
        </div>
      </div>,
    )
  } else if (editingRow !== undefined) {
    children.push(
      <div key="__overlay" data-testid="editor-overlay" style={overlayBackdrop}>
        <div style={overlayInner}>
          <TileEditor
            key={editingRow.entityId}
            row={editingRow}
            editor={editor}
            onClose={() => setEditingId(null)}
          />
        </div>
      </div>,
    )
  }

  const ownerActions = isOwner
    ? {
        headerActions: (
          <>
            <button
              type="button"
              style={mode === 'edit' ? headerButtonOn : headerButton}
              onClick={() => show(mode === 'edit' ? 'normal' : 'edit')}
            >
              {mode === 'edit' ? 'Done' : 'Edit'}
            </button>
            <button
              type="button"
              aria-label="Settings"
              style={headerButton}
              onClick={() => setShowDeploymentSettings(true)}
            >
              ⚙
            </button>
          </>
        ),
      }
    : {}

  const titleNode: ReactElement | string =
    isOwner && portals !== undefined && onSelectPortal !== undefined && onAddPortal !== undefined ? (
      <PortalDropdown
        portals={portals}
        selectedId={portalId}
        onSelect={onSelectPortal}
        onAddPortal={onAddPortal}
      />
    ) : (
      // Guest header keeps a plain title. There is no `portals` list to look
      // it up in — App.tsx already has it on the guest's own SessionResponse
      // and threads it straight through as `guestPortalTitle`.
      (guestPortalTitle ?? '')
    )

  const belowHeader = isOwner ? (
    <PortalSettingsAccordion
      portalId={portalId}
      onUpdated={(portal) => onPortalUpdated?.(portal)}
      onDeleted={() => onPortalDeleted?.()}
    />
  ) : undefined

  // The tiles are a theme's components, and the hooks inside them have to name
  // this portal on every action — an admin's portal is not in their session.
  return (
    <PortalIdProvider value={portalId}>
      <Shell
        title={titleNode}
        loggingOut={loggingOut}
        onLogout={() => {
          void handleLogout()
        }}
        belowHeader={belowHeader}
        {...ownerActions}
      >
        {children}
      </Shell>
    </PortalIdProvider>
  )
}
