import type { z } from 'zod'
import {
  AdminPortalResponse,
  type AllowlistRow,
  AllowlistResponse,
  type CatalogEntry,
  CatalogResponse,
  DevicesResponse,
  type Role,
  SessionResponse,
} from '@shared/api.js'
import type { ThemeId } from '@shared/themes.js'

type ApiSuccess<T> = { ok: true; data: T }
type ApiError = { ok: false; status: number; retryAfter: number } | { ok: false; status: number }
type ApiResult<T> = ApiSuccess<T> | ApiError

// Module-level unauthorized callback
let unauthorizedCallback: (() => void) | null = null

export function setUnauthorizedCallback(callback: (() => void) | null): void {
  unauthorizedCallback = callback
}

async function handleResponse<T>(
  response: Response,
  schema: { parse: (data: unknown) => T },
): Promise<ApiResult<T>> {
  if (!response.ok) {
    // Call unauthorized callback on 401
    if (response.status === 401 && unauthorizedCallback !== null) {
      unauthorizedCallback()
    }

    // Only attach retryAfter for 429 with valid numeric header
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After')
      if (retryAfterHeader) {
        const retryAfter = Number.parseInt(retryAfterHeader, 10)
        if (!Number.isNaN(retryAfter) && retryAfter >= 0) {
          return {
            ok: false,
            status: response.status,
            retryAfter,
          }
        }
      }
    }

    return {
      ok: false,
      status: response.status,
    }
  }

  const json = await response.json()
  const parsed = schema.parse(json)
  return { ok: true, data: parsed }
}

export async function login(
  password: string,
): Promise<ApiResult<{ role: Role; portalEnabled: boolean }>> {
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    credentials: 'same-origin',
  })

  return handleResponse(response, SessionResponse)
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', {
    method: 'POST',
    credentials: 'same-origin',
  })
}

export async function getSession(): Promise<{ role: Role; portalEnabled: boolean } | null> {
  const response = await fetch('/api/session', {
    credentials: 'same-origin',
  })

  if (response.status === 401) {
    return null
  }

  const json = await response.json()
  return SessionResponse.parse(json)
}

export async function getDevices(): Promise<ApiResult<z.infer<typeof DevicesResponse>>> {
  const response = await fetch('/api/devices', {
    credentials: 'same-origin',
  })

  return handleResponse(response, DevicesResponse)
}

export async function performAction(entityId: string, action: string): Promise<ApiResult<void>> {
  const response = await fetch(`/api/devices/${entityId}/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
  })

  if (!response.ok) {
    // Call unauthorized callback on 401
    if (response.status === 401 && unauthorizedCallback !== null) {
      unauthorizedCallback()
    }

    return {
      ok: false,
      status: response.status,
    }
  }

  return { ok: true, data: undefined }
}

export async function getCatalog(): Promise<ApiResult<CatalogEntry[]>> {
  const response = await fetch('/api/admin/entities', {
    credentials: 'same-origin',
  })

  const result = await handleResponse(response, CatalogResponse)
  if (!result.ok) return result

  return { ok: true, data: result.data.entities }
}

export async function getAllowlist(): Promise<
  ApiResult<{ devices: AllowlistRow[]; orphaned: string[] }>
> {
  const response = await fetch('/api/admin/allowlist', {
    credentials: 'same-origin',
  })

  return handleResponse(response, AllowlistResponse)
}

export async function putAllowlist(devices: AllowlistRow[]): Promise<ApiResult<void>> {
  const response = await fetch('/api/admin/allowlist', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devices }),
    credentials: 'same-origin',
  })

  if (!response.ok) {
    // Call unauthorized callback on 401
    if (response.status === 401 && unauthorizedCallback !== null) {
      unauthorizedCallback()
    }

    return {
      ok: false,
      status: response.status,
    }
  }

  return { ok: true, data: undefined }
}

export async function getAdminPortal(): Promise<
  ApiResult<{
    enabled: boolean
    integrationToken: string
    portalId: string
    theme: ThemeId
    title: string
  }>
> {
  const response = await fetch('/api/admin/portal', {
    credentials: 'same-origin',
  })

  return handleResponse(response, AdminPortalResponse)
}

export async function putAdminPortal(enabled: boolean): Promise<ApiResult<void>> {
  const response = await fetch('/api/admin/portal', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
    credentials: 'same-origin',
  })

  if (!response.ok) {
    if (response.status === 401 && unauthorizedCallback !== null) {
      unauthorizedCallback()
    }

    return {
      ok: false,
      status: response.status,
    }
  }

  return { ok: true, data: undefined }
}

export async function putAdminTheme(theme: ThemeId): Promise<ApiResult<void>> {
  const response = await fetch('/api/admin/theme', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
    credentials: 'same-origin',
  })

  if (!response.ok) {
    if (response.status === 401 && unauthorizedCallback !== null) {
      unauthorizedCallback()
    }

    return {
      ok: false,
      status: response.status,
    }
  }

  return { ok: true, data: undefined }
}

export async function putAdminTitle(title: string): Promise<ApiResult<void>> {
  const response = await fetch('/api/admin/title', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    credentials: 'same-origin',
  })

  if (!response.ok) {
    if (response.status === 401 && unauthorizedCallback !== null) {
      unauthorizedCallback()
    }

    return {
      ok: false,
      status: response.status,
    }
  }

  return { ok: true, data: undefined }
}
