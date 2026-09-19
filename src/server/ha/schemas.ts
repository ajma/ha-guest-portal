import { z } from 'zod'

// Authentication frames
export const AuthRequired = z.object({
  type: z.literal('auth_required'),
  ha_version: z.string(),
})

export const AuthOk = z.object({
  type: z.literal('auth_ok'),
  ha_version: z.string(),
})

export const AuthInvalid = z.object({
  type: z.literal('auth_invalid'),
  message: z.string(),
})

// Command result frames
export const ResultFrame = z.object({
  type: z.literal('result'),
  id: z.number(),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
})

export const PongFrame = z.object({
  type: z.literal('pong'),
  id: z.number(),
})

// Compressed state for entity events
const CompressedStateSchema = z.object({
  s: z.string().optional(),
  a: z.record(z.string(), z.unknown()).optional(),
  // Context: HA sends bare id string or object {id?, parent_id?, user_id?}. Not interpreted by this app.
  c: z.unknown().optional(),
  lc: z.number().optional(),
  lu: z.number().optional(),
})

export type CompressedState = z.infer<typeof CompressedStateSchema>

// Entity event payload structure
const EntityEventSchema = z.object({
  a: z.record(z.string(), CompressedStateSchema).optional(),
  c: z
    .record(
      z.string(),
      z.object({
        '+': CompressedStateSchema.optional(),
        '-': z.object({ a: z.array(z.string()).optional() }).optional(),
      }),
    )
    .optional(),
  r: z.array(z.string()).optional(),
})

export type EntityEvent = z.infer<typeof EntityEventSchema>

export const EventFrame = z.object({
  type: z.literal('event'),
  id: z.number(),
  event: EntityEventSchema,
})

// Discriminated union of all inbound frames
export const InboundFrame = z.discriminatedUnion('type', [
  AuthRequired,
  AuthOk,
  AuthInvalid,
  ResultFrame,
  PongFrame,
  EventFrame,
])

// Registry schemas - use .loose() to allow unknown fields
// Fields that HA always sends as present-but-null must be .nullable() not .optional()
export const RegistryEntity = z
  .object({
    entity_id: z.string(),
    name: z.string().nullable(),
    original_name: z.string().nullable(),
    area_id: z.string().nullable(),
    device_id: z.string().nullable(),
    disabled_by: z.string().nullable(),
    hidden_by: z.string().nullable(),
    entity_category: z.string().nullable(),
  })
  .loose()

export const RegistryDevice = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    name_by_user: z.string().nullable(),
    area_id: z.string().nullable(),
  })
  .loose()

export const RegistryArea = z
  .object({
    area_id: z.string(),
    name: z.string(),
  })
  .loose()
