import { describe, expect, it } from 'vitest'
import {
  AllowlistPutRequest,
  AllowlistResponse,
  CatalogResponse,
  DevicesResponse,
  IntegrationStateResponse,
  LoginRequest,
  PortalCreateRequest,
  PortalDetailResponse,
  PortalPutRequest,
  PortalSummaryResponse,
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
  it('accepts an admin session with no portal fields', () => {
    const result = SessionResponse.safeParse({ role: 'admin' })
    expect(result.success).toBe(true)
  })

  it('accepts a guest session carrying its portal', () => {
    const result = SessionResponse.safeParse({
      role: 'guest',
      portalId: 'p1',
      portalTitle: "Timothy's Portal",
      portalTheme: 'classic',
      portalEnabled: true,
    })
    expect(result.success).toBe(true)
  })

  it('rejects a guest session missing portal fields', () => {
    const result = SessionResponse.safeParse({ role: 'guest' })
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
          icon: 'mdi:lightbulb',
        },
        {
          entityId: 'climate.living',
          name: 'Living Room AC',
          area: null,
          domain: 'climate',
          supported: false,
          icon: null,
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

describe('PortalSummarySchema / PortalDetailSchema', () => {
  it('summary excludes the password', () => {
    const result = PortalSummaryResponse.safeParse({
      id: 'p1',
      title: 'Timothy',
      theme: 'classic',
      enabled: true,
    })
    expect(result.success).toBe(true)
  })

  it('detail requires the password', () => {
    const result = PortalDetailResponse.safeParse({
      id: 'p1',
      title: 'Timothy',
      theme: 'classic',
      enabled: true,
    })
    expect(result.success).toBe(false)
  })
})

describe('PortalCreateRequest', () => {
  it('accepts title and password', () => {
    const result = PortalCreateRequest.safeParse({ title: 'Timothy', password: 'a-secret-1' })
    expect(result.success).toBe(true)
  })
})

describe('PortalPutRequest', () => {
  it('accepts a partial update', () => {
    const result = PortalPutRequest.safeParse({ enabled: false })
    expect(result.success).toBe(true)
  })

  it('accepts an empty object (no-op update)', () => {
    const result = PortalPutRequest.safeParse({})
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

describe('IntegrationStateResponse', () => {
  it('accepts a list of portals', () => {
    const result = IntegrationStateResponse.safeParse({
      deploymentId: 'd1',
      haStale: false,
      version: '2.0.0',
      portals: [
        {
          portalId: 'p1',
          title: 'Timothy',
          enabled: true,
          deviceCount: 3,
          lastInteraction: null,
        },
      ],
    })
    expect(result.success).toBe(true)
  })
})

describe('portal SSE frames', () => {
  it('accepts a portal SSE frame', () => {
    expect(SseFrameSchema.parse({ type: 'portal', enabled: false })).toEqual({
      type: 'portal',
      enabled: false,
    })
  })

  it('rejects a portal frame without enabled', () => {
    expect(SseFrameSchema.safeParse({ type: 'portal' }).success).toBe(false)
  })
})
