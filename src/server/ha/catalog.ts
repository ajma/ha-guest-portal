import { z } from 'zod'
import type { HaConnection } from './connection.js'
import { RegistryEntity, RegistryDevice, RegistryArea } from './schemas.js'
import type { CatalogEntry } from '../../shared/api.js'
import { isSupportedEntity } from '../../shared/devices.js'

export async function fetchCatalog(conn: HaConnection): Promise<CatalogEntry[]> {
  // Fetch all three registries concurrently
  const [entities, devices, areas] = await Promise.all([
    conn.send(
      { type: 'config/entity_registry/list' },
      z.array(RegistryEntity)
    ),
    conn.send(
      { type: 'config/device_registry/list' },
      z.array(RegistryDevice)
    ),
    conn.send(
      { type: 'config/area_registry/list' },
      z.array(RegistryArea)
    ),
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

    // Resolve area: entity.area_id ?? device(entity.device_id).area_id
    let resolvedArea: string | null = null
    if (entity.area_id !== null) {
      const area = areaMap.get(entity.area_id)
      resolvedArea = area?.name ?? null
    } else if (entity.device_id !== null) {
      const device = deviceMap.get(entity.device_id)
      if (device !== undefined && device.area_id !== null) {
        const area = areaMap.get(device.area_id)
        resolvedArea = area?.name ?? null
      }
    }

    // Resolve display name: entity.name ?? entity.original_name ?? entityId
    const displayName = entity.name ?? entity.original_name ?? entity.entity_id

    // Extract domain from entity_id
    const domainMatch = /^([^.]+)\./.exec(entity.entity_id)
    const domain = domainMatch?.[1] ?? ''

    catalog.push({
      entityId: entity.entity_id,
      name: displayName,
      area: resolvedArea,
      domain,
      supported: isSupportedEntity(entity.entity_id),
    })
  }

  // Sort by display name
  catalog.sort((a, b) => a.name.localeCompare(b.name))

  return catalog
}
