export const DOMAIN_ACTIONS = {
  light: ['turn_on', 'turn_off', 'toggle'],
  switch: ['turn_on', 'turn_off', 'toggle'],
  fan: ['turn_on', 'turn_off', 'toggle'],
  input_boolean: ['turn_on', 'turn_off', 'toggle'],
  cover: ['open_cover', 'close_cover', 'stop_cover'],
  lock: ['lock', 'unlock'],
} as const

export type SupportedDomain = keyof typeof DOMAIN_ACTIONS
export type DeviceAction = (typeof DOMAIN_ACTIONS)[SupportedDomain][number]

function isSupportedDomain(domain: string): domain is SupportedDomain {
  return Object.hasOwn(DOMAIN_ACTIONS, domain)
}

export function parseDomain(entityId: string): SupportedDomain | null {
  const match = /^([a-z_]+)\.([a-z0-9_]+)$/.exec(entityId)
  if (!match) return null

  const domain = match[1]
  if (!domain) return null

  if (isSupportedDomain(domain)) {
    return domain
  }
  return null
}

export function isSupportedEntity(entityId: string): boolean {
  return parseDomain(entityId) !== null
}

export type ValidationFailure = {
  ok: false
  reason: 'not_allowlisted' | 'unsupported_domain' | 'action_not_valid_for_domain' | 'action_not_permitted'
}

export type ValidationSuccess = {
  ok: true
  domain: SupportedDomain
  service: DeviceAction
}

function isDeviceAction(action: string, domain: SupportedDomain): action is DeviceAction {
  const domainActions: readonly string[] = DOMAIN_ACTIONS[domain]
  return domainActions.includes(action)
}

export function validateAction(
  entityId: string,
  action: string,
  allowlist: ReadonlyMap<string, readonly string[]>,
): ValidationSuccess | ValidationFailure {
  // Gate 1: entity present in allowlist
  if (!allowlist.has(entityId)) {
    return { ok: false, reason: 'not_allowlisted' }
  }

  // Gate 2: domain parses and is supported
  const domain = parseDomain(entityId)
  if (domain === null) {
    return { ok: false, reason: 'unsupported_domain' }
  }

  // Gate 3: domain permits the action per DOMAIN_ACTIONS
  if (!isDeviceAction(action, domain)) {
    return { ok: false, reason: 'action_not_valid_for_domain' }
  }

  // Gate 4: row's allowedActions permits the action
  const allowedActions = allowlist.get(entityId)
  if (!allowedActions?.includes(action)) {
    return { ok: false, reason: 'action_not_permitted' }
  }

  // All gates passed
  return { ok: true, domain, service: action }
}
