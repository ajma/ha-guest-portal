import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import type { CatalogEntry, Device, Role } from '@shared/api.js'
import { getAllowlist, getCatalog } from '../api.js'
import { EntityPicker } from '../components/EntityPicker.js'
import { SettingsPanel } from '../components/SettingsPanel.js'
import { TileEditor } from '../components/TileEditor.js'
import { useAllowlistEditor } from '../hooks/useAllowlistEditor.js'
import { readPortalTitle } from '../portalTitle.js'
import { connectDeviceStore, useDeviceStore } from '../store.js'
import { activeTheme, componentsFor } from '../themes/active.js'
import type { DEFAULT_COMPONENTS } from '../themes/default/index.js'

type PortalProps = {
  role: Role
  onLogout: () => Promise<void>
}

type Components = typeof DEFAULT_COMPONENTS

/** Edit and Settings are mutually exclusive by construction, not by two
 * booleans kept in step. */
type Mode = 'normal' | 'edit' | 'settings'

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
const pickerInner: CSSProperties = {
  ...overlayInner,
  maxWidth: '720px',
  height: '100%',
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

export function Portal({ role, onLogout }: PortalProps): ReactElement {
  const [loggingOut, setLoggingOut] = useState(false)
  const [mode, setMode] = useState<Mode>('normal')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [orphaned, setOrphaned] = useState<string[]>([])
  const [orphanCheckFailed, setOrphanCheckFailed] = useState(false)

  // Held as state, seeded once from the attribute the server injected.
  //
  // The alternative — calling `readPortalTitle()` in the render body, as this
  // did — is only correct while nothing on the page can change the title. The
  // settings panel can, and a DOM attribute write does not re-render React, so
  // the owner renamed the portal and watched their own header keep the old
  // name. A callback from the panel is the smallest thing that closes it: the
  // title is one value owned by the page that renders the header, and the
  // panel is a child telling its parent what it saved. `PortalTitleField` also
  // writes the attribute back, so a later remount and the browser tab agree.
  const [title, setTitle] = useState(readPortalTitle)

  // Connect to the device store on mount
  useEffect(() => {
    const teardown = connectDeviceStore()
    return teardown
  }, [])

  const { devices, connected } = useDeviceStore()
  const editor = useAllowlistEditor(devices)
  const isOwner = role === 'admin'

  // The theme supplies the frame and every tile; this route only decides which
  // slot a device belongs in. Reading it per render is free — the slots are
  // stable module-level functions, so React sees the same element types.
  const components = componentsFor(activeTheme())
  const { Shell } = components

  /**
   * Which allowlist entries have no matching entity in Home Assistant — the
   * owner allowlisted something that has since been renamed, removed, or lost
   * its integration. The SSE stream cannot say this: it carries the devices
   * that exist, and an orphan is defined by an absence. So it is fetched, once
   * per entry into edit mode, and only for the owner.
   */
  const loadOrphaned = useCallback(async (): Promise<void> => {
    setOrphanCheckFailed(false)
    try {
      const result = await getAllowlist()
      if (!result.ok) {
        setOrphanCheckFailed(true)
        return
      }
      setOrphaned(result.data.orphaned)
    } catch {
      // Nothing in the api client guards `fetch` itself — offline, aborted and
      // DNS failures reject rather than returning `{ ok: false }`.
      setOrphanCheckFailed(true)
    }
  }, [])

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

  useEffect(() => {
    if (mode !== 'edit') return
    void loadOrphaned()
  }, [mode, loadOrphaned])

  function show(next: Mode): void {
    setMode(next)
    // Leaving edit mode drops whatever it had open. Without this, reopening
    // edit mode reopens the last editor the owner closed the mode on.
    setEditingId(null)
    setAdding(false)
  }

  // The row being edited is looked up fresh on every render. If another session
  // removes the device, the incoming snapshot drops it and the editor closes
  // rather than editing a ghost that the next mutation would resurrect.
  const editingRow =
    editingId === null ? undefined : editor.rows.find((row) => row.entityId === editingId)

  // Sort devices by sortOrder
  const sortedDevices = [...devices].sort((a, b) => a.sortOrder - b.sortOrder)

  // Tiles should be disabled only if disconnected
  // Stale state is shown visually but controls remain enabled
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
            <button
              type="button"
              style={smallButton}
              onClick={() => {
                void loadCatalog()
              }}
            >
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

  // Built as an array rather than as sibling JSX children: the Shell lays its
  // children out as grid cells, so one wrapping fragment would collapse the
  // whole grid into a single cell.
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
              orphaned={orphaned.includes(device.entityId)}
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
    if (orphanCheckFailed) {
      children.push(
        <div key="__orphan-error" style={panel}>
          <p style={errorText}>
            Could not check for orphaned devices — Home Assistant may be unreachable.
          </p>
          <div>
            <button
              type="button"
              style={smallButton}
              onClick={() => {
                void loadOrphaned()
              }}
            >
              Retry
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
          onClick={() => {
            setAdding(true)
            void loadCatalog()
          }}
        >
          + Add device
        </button>
      </div>,
    )

    children.push(
      <div key="__mode-banner" role="status" style={modeBanner}>
        Edit mode — tap a device to change it. Changes save as you make them.
      </div>,
    )
  }

  if (adding) {
    // The picker is an overlay, not an expanding grid cell. Expanded in place it
    // inherits one column's width — half a phone screen under `tiles` — which is
    // not enough for a search box above a scrolling list of every entity in the
    // house. It uses the same backdrop as the other two overlays.
    children.push(
      <div key="__overlay" data-testid="picker-overlay" style={overlayBackdrop}>
        <div style={pickerInner}>
          <section style={{ ...panel, flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>
            <div style={panelHeader}>
              <h2 style={panelHeading}>Add a device</h2>
              <button
                type="button"
                style={smallButton}
                onClick={() => {
                  setAdding(false)
                }}
              >
                Close
              </button>
            </div>
            {pickerBody()}
          </section>
        </div>
      </div>,
    )
  } else if (mode === 'settings') {
    children.push(
      <div key="__overlay" data-testid="settings-overlay" style={overlayBackdrop}>
        <div style={settingsInner}>
          <SettingsPanel
            onClose={() => {
              show('normal')
            }}
            onTitleChange={setTitle}
          />
        </div>
      </div>,
    )
  } else if (editingRow !== undefined) {
    children.push(
      <div key="__overlay" data-testid="editor-overlay" style={overlayBackdrop}>
        <div style={overlayInner}>
          {/* Keyed by entity id so the name field's draft is seeded from the
              row the owner actually opened. */}
          <TileEditor
            key={editingRow.entityId}
            row={editingRow}
            editor={editor}
            onClose={() => {
              setEditingId(null)
            }}
          />
        </div>
      </div>,
    )
  }

  // Spread rather than `headerActions={isOwner ? … : undefined}`: under
  // `exactOptionalPropertyTypes` an optional prop is present or absent, not
  // present-and-undefined — which is exactly the guarantee wanted here. A guest
  // page does not hand the Shell owner controls at all.
  const ownerActions = isOwner
    ? {
        headerActions: (
          <>
            <button
              type="button"
              style={mode === 'edit' ? headerButtonOn : headerButton}
              onClick={() => {
                show(mode === 'edit' ? 'normal' : 'edit')
              }}
            >
              {mode === 'edit' ? 'Done' : 'Edit'}
            </button>
            <button
              type="button"
              style={mode === 'settings' ? headerButtonOn : headerButton}
              onClick={() => {
                show(mode === 'settings' ? 'normal' : 'settings')
              }}
            >
              Settings
            </button>
          </>
        ),
      }
    : {}

  return (
    <Shell
      title={title}
      loggingOut={loggingOut}
      onLogout={() => {
        void handleLogout()
      }}
      {...ownerActions}
    >
      {children}
    </Shell>
  )
}
