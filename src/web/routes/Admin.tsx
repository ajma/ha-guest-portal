import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { AllowlistRow, CatalogEntry } from '@shared/api.js'
import { DOMAIN_ACTIONS, parseDomain } from '@shared/devices.js'
import { EntityPicker } from '../components/EntityPicker.js'
import * as api from '../api.js'

type AdminProps = {
  onLogout: () => Promise<void>
}

export function Admin({ onLogout }: AdminProps): ReactElement {
  const [loggingOut, setLoggingOut] = useState(false)
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  const [devices, setDevices] = useState<AllowlistRow[]>([])
  const [orphaned, setOrphaned] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [saveMessage, setSaveMessage] = useState<string>('')
  const [isDirty, setIsDirty] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)

    const catalogResult = await api.getCatalog()

    if (!catalogResult.ok) {
      setError('Failed to load catalog')
      setLoading(false)
      return
    }

    setCatalog(catalogResult.data)

    const allowlistResult = await api.getAllowlist()

    if (!allowlistResult.ok) {
      if (allowlistResult.status === 500) {
        setError('Cannot reach Home Assistant. Please check the connection and try again.')
      } else {
        setError('Failed to load allowlist')
      }
      setLoading(false)
      return
    }

    setDevices(allowlistResult.data.devices)
    setOrphaned(allowlistResult.data.orphaned)
    setIsDirty(false)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Guard unsaved changes
  useEffect(() => {
    if (!isDirty) return

    const handleBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [isDirty])

  const handleAdd = (entity: CatalogEntry): void => {
    const domain = parseDomain(entity.entityId)
    if (!domain) return

    const defaultActions = DOMAIN_ACTIONS[domain]
    const newDevice: AllowlistRow = {
      entityId: entity.entityId,
      label: entity.name,
      allowedActions: [...defaultActions],
      sortOrder: devices.length,
    }

    setDevices([...devices, newDevice])
    setSaveStatus('idle')
    setIsDirty(true)
  }

  const handleRemove = (index: number): void => {
    const newDevices = devices
      .filter((_, i) => i !== index)
      .map((device, i) => ({ ...device, sortOrder: i }))
    setDevices(newDevices)
    setSaveStatus('idle')
    setIsDirty(true)
  }

  const handleMoveUp = (index: number): void => {
    if (index === 0) return
    const newDevices = [...devices]
    const temp = newDevices[index - 1]
    const current = newDevices[index]
    if (temp && current) {
      newDevices[index - 1] = current
      newDevices[index] = temp
      // Re-index sortOrder and copy objects
      setDevices(newDevices.map((device, i) => ({ ...device, sortOrder: i })))
      setSaveStatus('idle')
      setIsDirty(true)
    }
  }

  const handleMoveDown = (index: number): void => {
    if (index === devices.length - 1) return
    const newDevices = [...devices]
    const temp = newDevices[index + 1]
    const current = newDevices[index]
    if (temp && current) {
      newDevices[index + 1] = current
      newDevices[index] = temp
      // Re-index sortOrder and copy objects
      setDevices(newDevices.map((device, i) => ({ ...device, sortOrder: i })))
      setSaveStatus('idle')
      setIsDirty(true)
    }
  }

  const handleLabelChange = (index: number, newLabel: string): void => {
    const newDevices = devices.map((device, i) =>
      i === index ? { ...device, label: newLabel } : device,
    )
    setDevices(newDevices)
    setSaveStatus('idle')
    setIsDirty(true)
  }

  const handleActionToggle = (index: number, action: string): void => {
    const newDevices = devices.map((device, i) => {
      if (i !== index) return device
      const hasAction = device.allowedActions.includes(action)
      return {
        ...device,
        allowedActions: hasAction
          ? device.allowedActions.filter((a) => a !== action)
          : [...device.allowedActions, action],
      }
    })
    setDevices(newDevices)
    setSaveStatus('idle')
    setIsDirty(true)
  }

  const handleSave = async (): Promise<void> => {
    setSaveStatus('idle')
    setSaveMessage('')

    const result = await api.putAllowlist(devices)

    if (result.ok) {
      // Re-fetch to get server-normalized data
      const allowlistResult = await api.getAllowlist()
      if (allowlistResult.ok) {
        setDevices(allowlistResult.data.devices)
        setOrphaned(allowlistResult.data.orphaned)
      }

      setSaveStatus('success')
      setSaveMessage('Allowlist saved successfully')
      setIsDirty(false)
    } else {
      setSaveStatus('error')
      if (result.status === 400) {
        setSaveMessage('Validation failed: Invalid allowlist configuration')
      } else {
        setSaveMessage('Failed to save allowlist')
      }
    }
  }

  async function handleLogout(): Promise<void> {
    setLoggingOut(true)
    await onLogout()
  }

  if (loading) {
    return <div data-testid="admin-screen">Loading...</div>
  }

  if (error) {
    return (
      <div data-testid="admin-screen">
        <h1>Admin Portal</h1>
        <p style={{ color: '#d9534f', fontWeight: 500 }}>{error}</p>
        <button
          type="button"
          onClick={load}
          style={{
            marginTop: '12px',
            padding: '8px 16px',
            fontSize: '14px',
            cursor: 'pointer',
            backgroundColor: '#5cb85c',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
          }}
        >
          Retry
        </button>
      </div>
    )
  }

  if (!catalog) {
    return <div data-testid="admin-screen">No catalog data</div>
  }

  const excludedIds = devices.map((d) => d.entityId)

  return (
    <div data-testid="admin-screen" style={{ padding: '24px', minHeight: '100vh' }}>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <h1 style={{ fontSize: '28px', fontWeight: 700, margin: 0 }}>Admin Portal</h1>
          <button
            type="button"
            onClick={() => {
              void handleLogout()
            }}
            disabled={loggingOut}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 500,
              color: '#374151',
              backgroundColor: 'white',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              cursor: loggingOut ? 'not-allowed' : 'pointer',
              opacity: loggingOut ? 0.5 : 1,
            }}
          >
            {loggingOut ? 'Logging out...' : 'Log out'}
          </button>
        </div>

        <section style={{ marginBottom: '24px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Add Entity</h2>
        <EntityPicker entities={catalog} exclude={excludedIds} onSelect={handleAdd} />
      </section>

        <section>
          <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '12px' }}>
            Allowed Devices ({devices.length})
          </h2>

        {devices.length === 0 ? (
          <p style={{ color: '#666', fontSize: '14px' }}>
            No devices configured. Use the picker above to add entities.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {devices.map((device, index) => {
              const domain = parseDomain(device.entityId)
              const actions = domain ? DOMAIN_ACTIONS[domain] : []
              const isOrphaned = orphaned.includes(device.entityId)

              return (
                <div
                  key={device.entityId}
                  data-testid={`allowlist-row-${index}`}
                  style={{
                    border: isOrphaned ? '2px solid #d9534f' : '1px solid #ccc',
                    borderRadius: '4px',
                    padding: '12px',
                    backgroundColor: isOrphaned ? '#fff5f5' : 'white',
                  }}
                >
                  {isOrphaned && (
                    <div
                      style={{
                        color: '#d9534f',
                        fontSize: '12px',
                        fontWeight: 600,
                        marginBottom: '8px',
                      }}
                    >
                      ⚠ Orphaned: Entity was renamed or removed in Home Assistant
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ marginBottom: '8px' }}>
                        <label
                          htmlFor={`label-${device.entityId}`}
                          style={{
                            display: 'block',
                            fontSize: '12px',
                            fontWeight: 500,
                            marginBottom: '4px',
                          }}
                        >
                          Label:
                        </label>
                        <input
                          id={`label-${device.entityId}`}
                          type="text"
                          value={device.label}
                          onChange={(e) => handleLabelChange(index, e.target.value)}
                          style={{
                            padding: '6px 8px',
                            fontSize: '14px',
                            border: '1px solid #ccc',
                            borderRadius: '4px',
                            width: '100%',
                          }}
                        />
                      </div>

                      <div style={{ fontSize: '12px', color: '#666', marginBottom: '8px' }}>
                        {device.entityId}
                      </div>

                      <div>
                        <div
                          style={{
                            fontSize: '12px',
                            fontWeight: 500,
                            marginBottom: '4px',
                          }}
                        >
                          Allowed Actions:
                        </div>
                        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                          {actions.map((action) => (
                            <label
                              key={action}
                              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                            >
                              <input
                                type="checkbox"
                                checked={device.allowedActions.includes(action)}
                                onChange={() => handleActionToggle(index, action)}
                              />
                              <span style={{ fontSize: '13px' }}>{action}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <button
                        type="button"
                        onClick={() => handleMoveUp(index)}
                        disabled={index === 0}
                        style={{
                          padding: '4px 8px',
                          fontSize: '12px',
                          cursor: index === 0 ? 'not-allowed' : 'pointer',
                          opacity: index === 0 ? 0.5 : 1,
                        }}
                      >
                        ↑ Up
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveDown(index)}
                        disabled={index === devices.length - 1}
                        style={{
                          padding: '4px 8px',
                          fontSize: '12px',
                          cursor: index === devices.length - 1 ? 'not-allowed' : 'pointer',
                          opacity: index === devices.length - 1 ? 0.5 : 1,
                        }}
                      >
                        ↓ Down
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemove(index)}
                        style={{
                          padding: '4px 8px',
                          fontSize: '12px',
                          cursor: 'pointer',
                          backgroundColor: '#d9534f',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          )}
        </section>

        <section style={{ marginTop: '24px' }}>
        <button
          type="button"
          onClick={handleSave}
          style={{
            padding: '10px 20px',
            fontSize: '14px',
            fontWeight: 600,
            backgroundColor: '#5cb85c',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Save
        </button>

        {saveStatus === 'success' && (
          <span style={{ marginLeft: '12px', color: '#5cb85c', fontSize: '14px' }}>
            {saveMessage}
          </span>
        )}

        {saveStatus === 'error' && (
          <span style={{ marginLeft: '12px', color: '#d9534f', fontSize: '14px' }}>
            {saveMessage}
          </span>
        )}
        </section>
      </div>
    </div>
  )
}
