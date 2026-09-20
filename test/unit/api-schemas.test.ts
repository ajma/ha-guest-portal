import { describe, expect, it } from 'vitest'
import {
  AdminPortalPutRequest,
  AdminPortalResponse,
  AdminThemePutRequest,
  AllowlistPutRequest,
  AllowlistResponse,
  CatalogResponse,
  DevicesResponse,
  IntegrationStateResponse,
  LoginRequest,
  SessionResponse,
  type SseFrame,
  SseFrameSchema,
} from '../../src/shared/api.ts'

describe('LoginRequest', () => {
  it('accepts a valid password', () => {
    const result = LoginRequest.safeParse({ password: 'secret123' })
    expect(result.success).toBe(true)
  })

  it('rejects missing password', () => {
    const result = LoginRequest.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('SessionResponse', () => {
  it('accepts guest role', () => {
    const result = SessionResponse.safeParse({ role: 'guest', portalEnabled: true })
    expect(result.success).toBe(true)
  })

  it('accepts admin role', () => {
    const result = SessionResponse.safeParse({ role: 'admin', portalEnabled: false })
    expect(result.success).toBe(true)
  })

  it('rejects invalid role', () => {
    const result = SessionResponse.safeParse({ role: 'superuser', portalEnabled: true })
    expect(result.success).toBe(false)
  })
})

describe('DevicesResponse', () => {
  it('accepts a valid response', () => {
    const payload = {
      devices: [
        {
          entityId: 'light.porch',
          label: 'Front Porch',
          domain: 'light',
          allowedActions: ['turn_on', 'turn_off'],
          sortOrder: 0,
          state: {
            state: 'on',
            attributes: { brightness: 255 },
            stale: false,
          },
        },
      ],
      stale: false,
    }
    const result = DevicesResponse.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('accepts empty devices array', () => {
    const result = DevicesResponse.safeParse({ devices: [], stale: true })
    expect(result.success).toBe(true)
  })
})

describe('CatalogResponse', () => {
  it('accepts a valid catalog', () => {
    const payload = {
      entities: [
        {
          entityId: 'light.bedroom',
          name: 'Bedroom Light',
          area: 'bedroom',
          domain: 'light',
          supported: true,
        },
        {
          entityId: 'climate.living',
          name: 'Living Room AC',
          area: null,
          domain: 'climate',
          supported: false,
        },
      ],
    }
    const result = CatalogResponse.safeParse(payload)
    expect(result.success).toBe(true)
  })
})

describe('AllowlistResponse', () => {
  it('accepts a valid response', () => {
    const payload = {
      devices: [
        {
          entityId: 'switch.kitchen',
          label: 'Kitchen Switch',
          allowedActions: ['toggle'],
          sortOrder: 1,
        },
      ],
      orphaned: ['light.deleted'],
    }
    const result = AllowlistResponse.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('accepts empty orphaned array', () => {
    const payload = { devices: [], orphaned: [] }
    const result = AllowlistResponse.safeParse(payload)
    expect(result.success).toBe(true)
  })
})

describe('AllowlistPutRequest', () => {
  it('accepts a valid payload', () => {
    const payload = {
      devices: [
        {
          entityId: 'light.porch',
          label: 'Front Porch',
          allowedActions: ['turn_on', 'turn_off'],
          sortOrder: 0,
        },
        {
          entityId: 'lock.front',
          label: 'Front Door',
          allowedActions: ['lock'],
          sortOrder: 1,
        },
      ],
    }
    const result = AllowlistPutRequest.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('accepts empty allowedActions (read-only device)', () => {
    const payload = {
      devices: [
        {
          entityId: 'light.status',
          label: 'Status Light',
          allowedActions: [],
          sortOrder: 0,
        },
      ],
    }
    const result = AllowlistPutRequest.safeParse(payload)
    expect(result.success).toBe(true)
  })

  it('rejects duplicate entityId values', () => {
    const payload = {
      devices: [
        {
          entityId: 'light.porch',
          label: 'Porch Light',
          allowedActions: ['turn_on'],
          sortOrder: 0,
        },
        {
          entityId: 'light.porch',
          label: 'Same Light',
          allowedActions: ['turn_off'],
          sortOrder: 1,
        },
      ],
    }
    const result = AllowlistPutRequest.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects empty label', () => {
    const payload = {
      devices: [
        {
          entityId: 'light.porch',
          label: '',
          allowedActions: ['turn_on'],
          sortOrder: 0,
        },
      ],
    }
    const result = AllowlistPutRequest.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects whitespace-only label', () => {
    const payload = {
      devices: [
        {
          entityId: 'light.porch',
          label: '   ',
          allowedActions: ['turn_on'],
          sortOrder: 0,
        },
      ],
    }
    const result = AllowlistPutRequest.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects unsupported domain', () => {
    const payload = {
      devices: [
        {
          entityId: 'climate.living',
          label: 'Living Room AC',
          allowedActions: ['turn_on'],
          sortOrder: 0,
        },
      ],
    }
    const result = AllowlistPutRequest.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('rejects action not valid for domain', () => {
    const payload = {
      devices: [
        {
          entityId: 'lock.front',
          label: 'Front Door',
          allowedActions: ['turn_on'],
          sortOrder: 0,
        },
      ],
    }
    const result = AllowlistPutRequest.safeParse(payload)
    expect(result.success).toBe(false)
  })

  it('accepts multiple different actions for a domain', () => {
    const payload = {
      devices: [
        {
          entityId: 'cover.garage',
          label: 'Garage Door',
          allowedActions: ['open_cover', 'close_cover', 'stop_cover'],
          sortOrder: 0,
        },
      ],
    }
    const result = AllowlistPutRequest.safeParse(payload)
    expect(result.success).toBe(true)
  })
})

describe('SseFrameSchema', () => {
  it('round-trips snapshot frame', () => {
    const frame: SseFrame = {
      type: 'snapshot',
      devices: [
        {
          entityId: 'fan.bedroom',
          label: 'Bedroom Fan',
          domain: 'fan',
          allowedActions: ['toggle'],
          sortOrder: 0,
          state: {
            state: 'off',
            attributes: { speed: 0 },
            stale: false,
          },
        },
      ],
      stale: false,
    }
    const result = SseFrameSchema.safeParse(frame)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(frame)
    }
  })

  it('round-trips patch frame', () => {
    const frame: SseFrame = {
      type: 'patch',
      devices: [
        {
          entityId: 'switch.outlet',
          label: 'Outlet',
          domain: 'switch',
          allowedActions: ['turn_on', 'turn_off'],
          sortOrder: 2,
          state: {
            state: 'on',
            attributes: {},
            stale: true,
          },
        },
      ],
    }
    const result = SseFrameSchema.safeParse(frame)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(frame)
    }
  })

  it('round-trips degraded frame', () => {
    const frame: SseFrame = {
      type: 'degraded',
      stale: true,
    }
    const result = SseFrameSchema.safeParse(frame)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(frame)
    }
  })

  it('rejects unknown frame type', () => {
    const result = SseFrameSchema.safeParse({
      type: 'unknown',
      data: {},
    })
    expect(result.success).toBe(false)
  })
})

describe('portal toggle schemas', () => {
  it('requires portalEnabled on SessionResponse', () => {
    expect(SessionResponse.safeParse({ role: 'guest' }).success).toBe(false)
    expect(SessionResponse.parse({ role: 'guest', portalEnabled: false })).toEqual({
      role: 'guest',
      portalEnabled: false,
    })
  })

  it('accepts a portal SSE frame', () => {
    expect(SseFrameSchema.parse({ type: 'portal', enabled: false })).toEqual({
      type: 'portal',
      enabled: false,
    })
  })

  it('rejects a portal frame without enabled', () => {
    expect(SseFrameSchema.safeParse({ type: 'portal' }).success).toBe(false)
  })

  it('parses an admin portal response', () => {
    expect(
      AdminPortalResponse.parse({
        enabled: true,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
        theme: 'classic',
        title: 'Guest Portal',
      }).enabled,
    ).toBe(true)
  })

  it('rejects a non-boolean enabled on the put request', () => {
    expect(AdminPortalPutRequest.safeParse({ enabled: 'yes' }).success).toBe(false)
  })

  it('parses an integration state response with a null interaction', () => {
    const parsed = IntegrationStateResponse.parse({
      portalId: '11111111-1111-1111-1111-111111111111',
      enabled: true,
      haStale: false,
      deviceCount: 3,
      version: '0.2.0',
      lastInteraction: null,
    })
    expect(parsed.lastInteraction).toBeNull()
  })

  it('parses an integration state response with an action interaction', () => {
    const parsed = IntegrationStateResponse.parse({
      portalId: '11111111-1111-1111-1111-111111111111',
      enabled: false,
      haStale: true,
      deviceCount: 0,
      version: '0.2.0',
      lastInteraction: {
        ts: 1,
        kind: 'action',
        entityId: 'lock.front',
        label: 'Front Door',
        action: 'unlock',
        ok: true,
      },
    })
    expect(parsed.lastInteraction?.kind).toBe('action')
  })
})

describe('theme schemas', () => {
  it('requires theme on the admin portal response', () => {
    expect(
      AdminPortalResponse.safeParse({
        enabled: true,
        integrationToken: 'a'.repeat(64),
        portalId: '11111111-1111-1111-1111-111111111111',
        // Everything but `theme`, so this still fails for the reason it names.
        title: 'Guest Portal',
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown theme id', () => {
    expect(AdminThemePutRequest.safeParse({ theme: 'bogus' }).success).toBe(false)
  })

  it('accepts each known theme id', () => {
    for (const id of ['tiles', 'cards', 'classic']) {
      expect(AdminThemePutRequest.parse({ theme: id }).theme).toBe(id)
    }
  })
})
