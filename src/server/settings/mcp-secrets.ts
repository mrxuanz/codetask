import type { McpSecretProvider } from './mcp-secret-provider'
import { formatMcpSecretReference, parseMcpSecretReference } from './mcp-secret-provider'

export const MCP_SECRET_MASK = '••••••'

const SENSITIVE_MCP_KEYS = new Set([
  'authorization',
  'apikey',
  'api_key',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'password'
])

export function isSensitiveMcpKey(key: string, parentKey?: string): boolean {
  const normalized = key.replace(/[-.]/g, '_').toLowerCase()
  const compact = normalized.replace(/_/g, '')
  if (SENSITIVE_MCP_KEYS.has(normalized) || SENSITIVE_MCP_KEYS.has(compact)) return true
  return (
    parentKey?.toLowerCase() === 'env' &&
    (normalized.endsWith('_key') ||
      normalized.endsWith('_token') ||
      normalized.endsWith('_secret') ||
      normalized.endsWith('_password'))
  )
}

export function redactMcpSensitiveValues(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactMcpSensitiveValues(item, parentKey))
  }
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      isSensitiveMcpKey(key, parentKey) ? MCP_SECRET_MASK : redactMcpSensitiveValues(child, key)
    ])
  )
}

function collectReferenceIds(value: unknown, ids: Set<string>, parentKey?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReferenceIds(item, ids, parentKey)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveMcpKey(key, parentKey)) {
      const id = parseMcpSecretReference(child)
      if (id) ids.add(id)
    } else {
      collectReferenceIds(child, ids, key)
    }
  }
}

export function collectMcpSecretReferenceIds(value: unknown): Set<string> {
  const ids = new Set<string>()
  collectReferenceIds(value, ids)
  return ids
}

function protectSubmittedValue(
  value: unknown,
  current: unknown,
  provider: McpSecretProvider,
  parentKey?: string
): unknown {
  if (Array.isArray(value)) {
    const currentList = Array.isArray(current) ? current : []
    return value.map((item, index) =>
      protectSubmittedValue(item, currentList[index], provider, parentKey)
    )
  }
  if (!value || typeof value !== 'object') return value
  const currentObject =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      if (!isSensitiveMcpKey(key, parentKey)) {
        return [key, protectSubmittedValue(child, currentObject[key], provider, key)]
      }
      if (child === MCP_SECRET_MASK) {
        const currentId = parseMcpSecretReference(currentObject[key])
        if (!currentId) throw new Error(`Masked MCP secret has no existing value at ${key}`)
        provider.resolve(currentId)
        return [key, formatMcpSecretReference(currentId)]
      }
      // API callers never receive reference IDs. Treat a submitted reference-shaped string as a
      // new secret value so an untrusted caller cannot point settings at another stored secret.
      return [key, formatMcpSecretReference(provider.store(child))]
    })
  )
}

export function protectSubmittedMcpSensitiveValues<T extends object>(
  value: T,
  current: T | Record<string, never>,
  provider: McpSecretProvider
): T {
  return protectSubmittedValue(value, current, provider) as T
}

function resolveProtectedValue(
  value: unknown,
  provider: McpSecretProvider,
  parentKey?: string
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveProtectedValue(item, provider, parentKey))
  }
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      if (!isSensitiveMcpKey(key, parentKey)) {
        return [key, resolveProtectedValue(child, provider, key)]
      }
      const id = parseMcpSecretReference(child)
      if (!id) throw new Error(`MCP secret is not protected at ${key}`)
      return [key, provider.resolve(id)]
    })
  )
}

export function resolveProtectedMcpSensitiveValues(
  value: Record<string, unknown>,
  provider: McpSecretProvider
): Record<string, unknown> {
  return resolveProtectedValue(value, provider) as Record<string, unknown>
}
