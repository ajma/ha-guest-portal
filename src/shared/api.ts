import { z } from 'zod'
import { DOMAIN_ACTIONS, parseDomain } from './devices.js'
import { MAX_PORTAL_TITLE_LENGTH } from './portalTitle.js'
import { THEME_IDS } from './themes.js'

// Role types
export type Role = 'guest' | 'admin'

// Authentication schemas
export const LoginRequest = z.object({
  password: z.string(),
})

export const SessionResponse = z.discriminatedUnion('role', [
  z.object({ role: z.literal('admin') }),
  z.object({
    role: z.literal('guest'),
    portalId: z.string(),
    portalTitle: z.string(),
    portalTheme: z.enum(THEME_IDS),
    portalEnabled: z.boolean(),
  }),
])

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

// Portal management schemas
const PortalFieldsSchema = z.object({
  id: z.string(),
  title: z.string(),
  theme: z.enum(THEME_IDS),
  enabled: z.boolean(),
})

export const PortalSummaryResponse = PortalFieldsSchema
export const PortalsListResponse = z.object({ portals: z.array(PortalFieldsSchema) })

export const PortalDetailResponse = PortalFieldsSchema.extend({
  password: z.string(),
})

// The length cap is enforced here rather than left to `normalizePortalTitle`'s
// silent truncation: an owner who pastes something too long should be told, not
// have the tail quietly removed behind their back.
export const PortalCreateRequest = z.object({
  title: z
    .string()
    .max(MAX_PORTAL_TITLE_LENGTH, `Title must be ${MAX_PORTAL_TITLE_LENGTH} characters or fewer`),
  password: z.string().min(8),
})

export const PortalPutRequest = z.object({
  title: z
    .string()
    .max(MAX_PORTAL_TITLE_LENGTH, `Title must be ${MAX_PORTAL_TITLE_LENGTH} characters or fewer`)
    .optional(),
  theme: z.enum(THEME_IDS).optional(),
  enabled: z.boolean().optional(),
  password: z.string().min(8).optional(),
})

export const DeploymentSettingsResponse = z.object({
  integrationToken: z.string(),
  deploymentId: z.string(),
})

export const LastSelectedPortalPutRequest = z.object({
  portalId: z.string(),
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
  deploymentId: z.string(),
  haStale: z.boolean(),
  version: z.string(),
  portals: z.array(
    z.object({
      portalId: z.string(),
      title: z.string(),
      enabled: z.boolean(),
      deviceCount: z.number(),
      lastInteraction: InteractionSchema.nullable(),
    }),
  ),
})

export const IntegrationEnabledRequest = z.object({
  enabled: z.boolean(),
})
