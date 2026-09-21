import { z } from 'zod'
import { DOMAIN_ACTIONS, parseDomain } from './devices.js'
import { MAX_PORTAL_TITLE_LENGTH } from './portalTitle.js'
import { THEME_IDS } from './themes.js'

// Role types
export type Role = 'guest' | 'admin'
const RoleSchema = z.enum(['guest', 'admin'])

// Authentication schemas
export const LoginRequest = z.object({
  password: z.string(),
})

export const SessionResponse = z.object({
  role: RoleSchema,
  portalEnabled: z.boolean(),
})

// Device state and device schemas
export type DeviceState = z.infer<typeof DeviceStateSchema>
const DeviceStateSchema = z.object({
  state: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  stale: z.boolean(),
})

export type Device = z.infer<typeof DeviceSchema>
const DeviceSchema = z.object({
  entityId: z.string(),
  label: z.string(),
  domain: z.string(),
  allowedActions: z.array(z.string()),
  sortOrder: z.number(),
  state: DeviceStateSchema,
})

export const DevicesResponse = z.object({
  devices: z.array(DeviceSchema),
  stale: z.boolean(),
})

// Catalog schemas
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>
const CatalogEntrySchema = z.object({
  entityId: z.string(),
  name: z.string(),
  area: z.string().nullable(),
  domain: z.string(),
  supported: z.boolean(),
  icon: z.string().nullable(),
})

export const CatalogResponse = z.object({
  entities: z.array(CatalogEntrySchema),
})

// Allowlist schemas
export type AllowlistRow = z.infer<typeof AllowlistRowSchema>
const AllowlistRowSchema = z.object({
  entityId: z.string(),
  label: z.string(),
  allowedActions: z.array(z.string()),
  sortOrder: z.number(),
})

export const AllowlistPutRequest = z
  .object({
    devices: z.array(AllowlistRowSchema),
  })
  .superRefine((data, ctx) => {
    // Check for duplicate entityId values
    const seen = new Set<string>()
    for (let i = 0; i < data.devices.length; i++) {
      const device = data.devices[i]
      if (!device) continue

      const entityId = device.entityId
      if (seen.has(entityId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate entityId: ${entityId}`,
          path: ['devices', i, 'entityId'],
        })
      }
      seen.add(entityId)
    }

    // Validate each device
    for (let i = 0; i < data.devices.length; i++) {
      const device = data.devices[i]
      if (!device) continue

      // Check for empty or whitespace-only label
      if (device.label.trim() === '') {
        ctx.addIssue({
          code: 'custom',
          message: 'Label cannot be empty or whitespace-only',
          path: ['devices', i, 'label'],
        })
      }

      // Check for supported domain
      const domain = parseDomain(device.entityId)
      if (domain === null) {
        ctx.addIssue({
          code: 'custom',
          message: `Entity ${device.entityId} has unsupported or malformed domain`,
          path: ['devices', i, 'entityId'],
        })
        continue
      }

      // Check that all allowedActions are valid for the domain
      const validActions = DOMAIN_ACTIONS[domain]
      for (const action of device.allowedActions) {
        const isValid = validActions.some((validAction) => validAction === action)
        if (!isValid) {
          ctx.addIssue({
            code: 'custom',
            message: `Action '${action}' is not valid for domain '${domain}'`,
            path: ['devices', i, 'allowedActions'],
          })
        }
      }
    }
  })

export const AllowlistResponse = z.object({
  devices: z.array(AllowlistRowSchema),
  orphaned: z.array(z.string()),
})

// SSE Frame schemas
const SnapshotFrameSchema = z.object({
  type: z.literal('snapshot'),
  devices: z.array(DeviceSchema),
  stale: z.boolean(),
})

const PatchFrameSchema = z.object({
  type: z.literal('patch'),
  devices: z.array(DeviceSchema),
})

const DegradedFrameSchema = z.object({
  type: z.literal('degraded'),
  stale: z.boolean(),
})

const PortalFrameSchema = z.object({
  type: z.literal('portal'),
  enabled: z.boolean(),
})

export type SseFrame = z.infer<typeof SseFrameSchema>
export const SseFrameSchema = z.discriminatedUnion('type', [
  SnapshotFrameSchema,
  PatchFrameSchema,
  DegradedFrameSchema,
  PortalFrameSchema,
])

// Portal toggle schemas
export const AdminPortalResponse = z.object({
  enabled: z.boolean(),
  integrationToken: z.string(),
  portalId: z.string(),
  theme: z.enum(THEME_IDS),
  title: z.string(),
})

export const AdminPortalPutRequest = z.object({
  enabled: z.boolean(),
})

export const AdminThemePutRequest = z.object({
  theme: z.enum(THEME_IDS),
})

// The length cap is enforced here rather than left to `normalizePortalTitle`'s
// silent truncation: an owner who pastes something too long should be told, not
// have the tail quietly removed behind their back.
export const AdminTitlePutRequest = z.object({
  title: z
    .string()
    .max(MAX_PORTAL_TITLE_LENGTH, `Title must be ${MAX_PORTAL_TITLE_LENGTH} characters or fewer`),
})

const InteractionSchema = z.object({
  ts: z.number(),
  kind: z.enum(['action', 'login']),
  entityId: z.string().nullable(),
  label: z.string().nullable(),
  action: z.string().nullable(),
  ok: z.boolean(),
})

export const IntegrationStateResponse = z.object({
  portalId: z.string(),
  enabled: z.boolean(),
  haStale: z.boolean(),
  deviceCount: z.number(),
  version: z.string(),
  lastInteraction: InteractionSchema.nullable(),
})

export const IntegrationEnabledRequest = z.object({
  enabled: z.boolean(),
})
