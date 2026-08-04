import type {
  SettingsProviderCode,
  ProviderRuntimeSetting,
  ProviderRuntimeSettings
} from '@codetask/contracts'
import { SettingsError } from './settings-errors.ts'
import { contentHash, PROVIDER_CODES, trySettingsProviderCode } from './setting-namespace.ts'

export function defaultProviderRuntimeSettings(): ProviderRuntimeSettings {
  const providers: Record<string, ProviderRuntimeSetting> = {}
  for (const code of PROVIDER_CODES) {
    providers[code] = {
      enabled: true,
      executable: { mode: 'auto' },
      approveMcps: code === 'cursor'
    }
  }
  return { providers }
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw SettingsError.badRequest('settings.invalid_payload', 'Expected a non-empty string')
  }
  return value.trim()
}

function parseExecutable(value: unknown, path: string): ProviderRuntimeSetting['executable'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw SettingsError.badRequest(
      'settings.invalid_payload',
      `${path}.executable must be an object`
    )
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'mode' && key !== 'path') {
      throw SettingsError.badRequest(
        'settings.invalid_payload',
        `${path}.executable.${key} is not supported`
      )
    }
  }
  if (record.mode === 'path') {
    const pathValue = optionalTrimmedString(record.path)
    if (!pathValue) {
      throw SettingsError.badRequest(
        'settings.invalid_payload',
        `${path}.executable.path is required`
      )
    }
    return { mode: 'path', path: pathValue }
  }
  if (record.mode !== 'auto') {
    throw SettingsError.badRequest(
      'settings.invalid_payload',
      `${path}.executable.mode must be auto or path`
    )
  }
  return { mode: 'auto' }
}

function parseProviderRuntimeSetting(
  value: unknown,
  code: SettingsProviderCode
): ProviderRuntimeSetting {
  const defaults = defaultProviderRuntimeSettings().providers[code]!
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaults
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!['enabled', 'executable', 'model', 'endpoint', 'approveMcps'].includes(key)) {
      throw SettingsError.badRequest(
        'settings.invalid_payload',
        `providers.${code}.${key} is not supported`
      )
    }
  }
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : defaults.enabled,
    executable:
      record.executable !== undefined
        ? parseExecutable(record.executable, `providers.${code}`)
        : defaults.executable,
    model: record.model !== undefined ? optionalTrimmedString(record.model) : defaults.model,
    endpoint:
      record.endpoint !== undefined ? optionalTrimmedString(record.endpoint) : defaults.endpoint,
    approveMcps: typeof record.approveMcps === 'boolean' ? record.approveMcps : defaults.approveMcps
  }
}

export function parseProviderRuntimeSettings(value: unknown): ProviderRuntimeSettings {
  const defaults = defaultProviderRuntimeSettings()
  if (value === undefined || value === null) return defaults
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw SettingsError.badRequest('settings.invalid_payload', 'provider_runtime must be an object')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'providers') {
      throw SettingsError.badRequest('settings.invalid_payload', `Unknown field: ${key}`)
    }
  }
  const rawProviders = record.providers
  if (rawProviders === undefined) return defaults
  if (typeof rawProviders !== 'object' || Array.isArray(rawProviders) || rawProviders === null) {
    throw SettingsError.badRequest('settings.invalid_payload', 'providers must be an object')
  }
  const providerRecord = rawProviders as Record<string, unknown>
  for (const code of Object.keys(providerRecord)) {
    if (!trySettingsProviderCode(code)) {
      throw SettingsError.badRequest('settings.provider_unknown', `Unknown provider: ${code}`)
    }
  }
  const providers = { ...defaults.providers }
  for (const [rawCode, rawValue] of Object.entries(providerRecord)) {
    const code = trySettingsProviderCode(rawCode)
    if (!code || rawValue === undefined) continue
    providers[code] = parseProviderRuntimeSetting(rawValue, code)
  }
  return { providers }
}

export function normalizeProviderRuntimeSettings(value: unknown): ProviderRuntimeSettings {
  return parseProviderRuntimeSettings(value)
}

export function validateProviderRuntimeSettings(
  value: ProviderRuntimeSettings,
  options?: { isProviderAvailable?: (code: SettingsProviderCode) => boolean }
): ProviderRuntimeSettings {
  for (const code of PROVIDER_CODES) {
    const setting = value.providers[code]
    if (!setting) {
      throw SettingsError.badRequest(
        'settings.invalid_payload',
        `Missing provider settings for ${code}`
      )
    }
    if (options?.isProviderAvailable && setting.enabled && !options.isProviderAvailable(code)) {
      throw SettingsError.badRequest(
        'settings.provider_unavailable',
        `Provider unavailable: ${code}`
      )
    }
  }
  return value
}

export function mergeProviderRuntimeSettings(
  saved: ProviderRuntimeSettings,
  effectiveOverrides: ProviderRuntimeSettings
): ProviderRuntimeSettings {
  const providers = { ...saved.providers }
  for (const code of PROVIDER_CODES) {
    if (effectiveOverrides.providers[code]) {
      providers[code] = effectiveOverrides.providers[code]!
    }
  }
  return { providers }
}

export function providerRuntimeRestartRequired(
  saved: ProviderRuntimeSettings,
  effective: ProviderRuntimeSettings
): boolean {
  return contentHash(saved) !== contentHash(effective)
}
