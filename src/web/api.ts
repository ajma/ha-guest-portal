import type { z } from 'zod'
import { apiUrl } from './basePath.js'
import {
  AllowlistPutRequest,
  type AllowlistRow,
  AllowlistResponse,
  type CatalogEntry,
  CatalogResponse,
  DeploymentSettingsResponse,
  DevicesResponse,
  LastSelectedPortalPutRequest,
  type PortalCreateRequest,
  PortalDetailResponse,
  type PortalPutRequest,
  PortalsListResponse,
  SessionResponse,
} from '@shared/api.js'

type ApiSuccess<T> = { ok: true; data: T }
type ApiError = { ok: false; status: number; retryAfter: number } | { ok: false; status: number }
type ApiResult<T> = ApiSuccess<T> | ApiError

let unauthorizedCallback: (() => void) | null = null

export function setUnauthorizedCallback(callback: (() => void) | null): void {
  unauthorizedCallback = callback
}

async function handleResponse<T>(
  response: Response,
  schema: { parse: (data: unknown) => T },
): Promise<ApiResult<T>> {
  if (!response.ok) {
    if (response.status === 401 && unauthorizedCallback !== null) {
      unauthorizedCallback()
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After')
      if (retryAfterHeader) {
        const retryAfter = Number.parseInt(retryAfterHeader, 10)
        if (!Number.isNaN(retryAfter) && retryAfter >= 0) {
          return { ok: false, status: response.status, retryAfter }
        }
      }
    }

    return { ok: false, status: response.status }
  }

  const json = await response.json()
  const parsed = schema.parse(json)
  return { ok: true, data: parsed }
}

function withPortalId(path: string, portalId?: string): string {
  return portalId === undefined ? path : `${path}?portalId=${encodeURIComponent(portalId)}`
}

export async function login(
  password: string,
): Promise<ApiResult<z.infer<typeof SessionResponse>>> {
  const response = await fetch(apiUrl('/api/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    credentials: 'same-origin',
  })

  return handleResponse(response, SessionResponse)
}

export async function logout(): Promise<void> {
  await fetch(apiUrl('/api/logout'), { method: 'POST', credentials: 'same-origin' })
}

export async function getSession(): Promise<z.infer<typeof SessionResponse> | null> {
  const response = await fetch(apiUrl('/api/session'), { credentials: 'same-origin' })

  if (response.status === 401) {
    return null
  }

  const json = await response.json()
  return SessionResponse.parse(json)
}

export async function getDevices(portalId?: string): Promise<ApiResult<z.infer<typeof DevicesResponse>>> {
  const response = await fetch(apiUrl(withPortalId('/api/devices', portalId)), {
    credentials: 'same-origin',
  })

  return handleResponse(response, DevicesResponse)
}

// `portalId` is required rather than optional: an admin without it gets a flat
// 400 from the server, and an optional parameter let every call site omit it
// while still type-checking.
export async function performAction(
  entityId: string,
  action: string,
  portalId: string | undefined,
): Promise<ApiResult<void>> {
  const response = await fetch(
    apiUrl(withPortalId(`/api/devices/${entityId}/${action}`, portalId)),
    { method: 'POST', credentials: 'same-origin' },
  )

  if (!response.ok) {
    if (response.status === 401 && unauthorizedCallback !== null) {
      unauthorizedCallback()
    }
    return { ok: false, status: response.status }
  }

  return { ok: true, data: undefined }
}

export async function getCatalog(): Promise<ApiResult<CatalogEntry[]>> {
  const response = await fetch(apiUrl('/api/admin/entities'), { credentials: 'same-origin' })
  const result = await handleResponse(response, CatalogResponse)
  if (!result.ok) return result
  return { ok: true, data: result.data.entities }
}

export async function getPortals(): Promise<
  ApiResult<z.infer<typeof PortalsListResponse>>
> {
  const response = await fetch(apiUrl('/api/admin/portals'), { credentials: 'same-origin' })
  return handleResponse(response, PortalsListResponse)
}

export async function createPortal(
  input: z.infer<typeof PortalCreateRequest>,
): Promise<ApiResult<z.infer<typeof PortalDetailResponse>>> {
  const response = await fetch(apiUrl('/api/admin/portals'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'same-origin',
  })
  return handleResponse(response, PortalDetailResponse)
}

export async function getPortal(
  portalId: string,
): Promise<ApiResult<z.infer<typeof PortalDetailResponse>>> {
  const response = await fetch(apiUrl(`/api/admin/portals/${portalId}`), {
    credentials: 'same-origin',
  })
  return handleResponse(response, PortalDetailResponse)
}

export async function updatePortal(
  portalId: string,
  patch: z.infer<typeof PortalPutRequest>,
): Promise<ApiResult<z.infer<typeof PortalDetailResponse>>> {
  const response = await fetch(apiUrl(`/api/admin/portals/${portalId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    credentials: 'same-origin',
  })
  return handleResponse(response, PortalDetailResponse)
}

export async function deletePortal(portalId: string): Promise<ApiResult<void>> {
  const response = await fetch(apiUrl(`/api/admin/portals/${portalId}`), {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  if (!response.ok) return { ok: false, status: response.status }
  return { ok: true, data: undefined }
}

export async function getPortalAllowlist(
  portalId: string,
): Promise<ApiResult<{ devices: AllowlistRow[]; orphaned: string[] }>> {
  const response = await fetch(apiUrl(`/api/admin/portals/${portalId}/allowlist`), {
    credentials: 'same-origin',
  })
  return handleResponse(response, AllowlistResponse)
}

export async function putPortalAllowlist(
  portalId: string,
  devices: AllowlistRow[],
): Promise<ApiResult<void>> {
  const response = await fetch(apiUrl(`/api/admin/portals/${portalId}/allowlist`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(AllowlistPutRequest.parse({ devices })),
    credentials: 'same-origin',
  })
  if (!response.ok) {
    if (response.status === 401 && unauthorizedCallback !== null) unauthorizedCallback()
    return { ok: false, status: response.status }
  }
  return { ok: true, data: undefined }
}

export async function getDeploymentSettings(): Promise<
  ApiResult<z.infer<typeof DeploymentSettingsResponse>>
> {
  const response = await fetch(apiUrl('/api/admin/settings'), { credentials: 'same-origin' })
  return handleResponse(response, DeploymentSettingsResponse)
}

export async function putLastSelectedPortal(portalId: string): Promise<ApiResult<void>> {
  const response = await fetch(apiUrl('/api/admin/last-selected-portal'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(LastSelectedPortalPutRequest.parse({ portalId })),
    credentials: 'same-origin',
  })
  if (!response.ok) return { ok: false, status: response.status }
  return { ok: true, data: undefined }
}
