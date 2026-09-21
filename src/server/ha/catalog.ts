import { z } from 'zod'
import type { CatalogEntry } from '../../shared/api.js'
import { isSupportedEntity } from '../../shared/devices.js'
import type { HaConnection } from './connection.js'
import { RegistryArea, RegistryDevice, RegistryEntity } from './schemas.js'

// Treat empty or whitespace-only strings as absent
function nonEmpty(s: string | null | undefined): string | null {
  if (s == null) return null
  const trimmed = s.trim()
  return trimmed.length > 0 ? trimmed : null
}

// Mirrors Home Assistant's Entity.icon precedence: a user's registry override
// wins, otherwise fall back to the integration's original_icon.
function resolveIcon(entity: z.infer<typeof RegistryEntity>): string | null {
  return nonEmpty(entity.icon) ?? nonEmpty(entity.original_icon)
}

// Mirrors Home Assistant's Entity._friendly_name_internal precedence
function resolveDisplayName(
  entity: z.infer<typeof RegistryEntity>,
  device: z.infer<typeof RegistryDevice> | undefined,
): string {
  // 1. Registry override always wins
  const registryName = nonEmpty(entity.name)
  if (registryName !== null) return registryName

  // 2. If has_entity_name is true and entity has a device: use device name + optional suffix
  if (entity.has_entity_name === true && device !== undefined) {
    const deviceName = nonEmpty(device.name_by_user) ?? nonEmpty(device.name)
    if (deviceName !== null) {
      const suffix = nonEmpty(entity.original_name)
      return suffix !== null ? `${deviceName} ${suffix}` : deviceName
    }
  }

  // 3. Otherwise original_name
  const originalName = nonEmpty(entity.original_name)
  if (originalName !== null) return originalName

  // 4. Fall back to entity_id
  return entity.entity_id
}

export async function fetchCatalog(conn: HaConnection): Promise<CatalogEntry[]> {
  // Fetch all three registries concurrently
  const [entities, devices, areas] = await Promise.all([
    conn.send({ type: 'config/entity_registry/list' }, z.array(RegistryEntity)),
    conn.send({ type: 'config/device_registry/list' }, z.array(RegistryDevice)),
    conn.send({ type: 'config/area_registry/list' }, z.array(RegistryArea)),
  ])

  // Build lookup maps
  const deviceMap = new Map(devices.map((d) => [d.id, d]))
  const areaMap = new Map(areas.map((a) => [a.area_id, a]))

  // Process entities
  const catalog: CatalogEntry[] = []

  for (const entity of entities) {
    // Exclude disabled or hidden entities
    if (entity.disabled_by !== null || entity.hidden_by !== null) {
      continue
    }

    // Resolve device for both area and name resolution
    const device = entity.device_id !== null ? deviceMap.get(entity.device_id) : undefined

    // Resolve area: entity.area_id ?? device(entity.device_id).area_id
    let resolvedArea: string | null = null
    if (entity.area_id !== null) {
      const area = areaMap.get(entity.area_id)
      resolvedArea = area?.name ?? null
    } else if (device !== undefined && device.area_id !== null) {
      const area = areaMap.get(device.area_id)
      resolvedArea = area?.name ?? null
    }

    // Resolve display name using HA's algorithm
    const displayName = resolveDisplayName(entity, device)

    // Extract domain from entity_id
    const domainMatch = /^([^.]+)\./.exec(entity.entity_id)
    const domain = domainMatch?.[1] ?? ''

    catalog.push({
      entityId: entity.entity_id,
      name: displayName,
      area: resolvedArea,
      domain,
      supported: isSupportedEntity(entity.entity_id),
      icon: resolveIcon(entity),
    })
  }

  // Sort by display name
  catalog.sort((a, b) => a.name.localeCompare(b.name))

  return catalog
}
