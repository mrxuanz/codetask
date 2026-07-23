import { SUPPORTED_CORE_CODES, type SupportedCoreCode } from './codes'

export type ProviderExecutableSetting =
  | { readonly mode: 'auto' }
  | { readonly mode: 'path'; readonly path: string }

export interface ProviderSettings {
  readonly enabled: boolean
  readonly executable: ProviderExecutableSetting
  readonly model?: string | undefined
  readonly endpoint?: string | undefined
  readonly approveMcps: boolean
}

export type ProvidersConfig = Readonly<Record<SupportedCoreCode, ProviderSettings>>

export type ProviderSettingsOverride = Partial<
  Omit<ProviderSettings, 'executable'> & {
    executable: ProviderExecutableSetting
  }
>

export type ProvidersConfigOverrides = Partial<Record<SupportedCoreCode, ProviderSettingsOverride>>

function defaultProviderSettings(code: SupportedCoreCode): ProviderSettings {
  return {
    enabled: true,
    executable: { mode: 'auto' },
    approveMcps: code === 'cursorcli'
  }
}

export const DEFAULT_PROVIDERS_CONFIG: ProvidersConfig = Object.freeze(
  Object.fromEntries(
    SUPPORTED_CORE_CODES.map((code) => [code, Object.freeze(defaultProviderSettings(code))])
  ) as Record<SupportedCoreCode, ProviderSettings>
)

function optionalTrimmedString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

export function validateProviderSettings(
  code: SupportedCoreCode,
  value: ProviderSettings
): ProviderSettings {
  if (typeof value.enabled !== 'boolean') {
    throw new Error(`providers.${code}.enabled must be a boolean`)
  }
  if (typeof value.approveMcps !== 'boolean') {
    throw new Error(`providers.${code}.approveMcps must be a boolean`)
  }
  if (!value.executable || (value.executable.mode !== 'auto' && value.executable.mode !== 'path')) {
    throw new Error(`providers.${code}.executable.mode must be auto or path`)
  }

  const executable =
    value.executable.mode === 'path'
      ? {
          mode: 'path' as const,
          path:
            optionalTrimmedString(value.executable.path, `providers.${code}.executable.path`) ?? ''
        }
      : { mode: 'auto' as const }

  return Object.freeze({
    enabled: value.enabled,
    executable,
    model: optionalTrimmedString(value.model, `providers.${code}.model`),
    endpoint: optionalTrimmedString(value.endpoint, `providers.${code}.endpoint`),
    approveMcps: value.approveMcps
  })
}

export function createProvidersConfig(overrides: ProvidersConfigOverrides = {}): ProvidersConfig {
  return Object.freeze(
    Object.fromEntries(
      SUPPORTED_CORE_CODES.map((code) => {
        const base = DEFAULT_PROVIDERS_CONFIG[code]
        const override = overrides[code]
        return [
          code,
          validateProviderSettings(code, {
            ...base,
            ...override,
            executable: override?.executable ?? base.executable
          })
        ]
      })
    ) as Record<SupportedCoreCode, ProviderSettings>
  )
}

export function mergeProvidersConfigOverrides(
  base: ProvidersConfigOverrides | undefined,
  override: ProvidersConfigOverrides | undefined
): ProvidersConfigOverrides {
  return Object.fromEntries(
    SUPPORTED_CORE_CODES.map((code) => {
      const baseValue = base?.[code]
      const overrideValue = override?.[code]
      return [
        code,
        {
          ...baseValue,
          ...overrideValue,
          executable: overrideValue?.executable ?? baseValue?.executable
        }
      ]
    })
  ) as ProvidersConfigOverrides
}

const PROVIDER_SETTING_KEYS = new Set(['enabled', 'executable', 'model', 'endpoint', 'approveMcps'])

export function parseProvidersConfigOverrides(value: unknown): ProvidersConfigOverrides {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('providers must be an object')
  }

  const record = value as Record<string, unknown>
  for (const code of Object.keys(record)) {
    if (!SUPPORTED_CORE_CODES.includes(code as SupportedCoreCode)) {
      throw new Error(`providers.${code} is not a supported Provider`)
    }
    const provider = record[code]
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      throw new Error(`providers.${code} must be an object`)
    }
    for (const key of Object.keys(provider)) {
      if (!PROVIDER_SETTING_KEYS.has(key)) {
        throw new Error(`providers.${code}.${key} is not supported`)
      }
    }
    const executable = (provider as Record<string, unknown>).executable
    if (executable !== undefined) {
      if (!executable || typeof executable !== 'object' || Array.isArray(executable)) {
        throw new Error(`providers.${code}.executable must be an object`)
      }
      const executableRecord = executable as Record<string, unknown>
      for (const key of Object.keys(executableRecord)) {
        if (key !== 'mode' && key !== 'path') {
          throw new Error(`providers.${code}.executable.${key} is not supported`)
        }
      }
      if (executableRecord.mode === 'auto' && executableRecord.path !== undefined) {
        throw new Error(`providers.${code}.executable.path requires mode path`)
      }
    }
  }
  return record as ProvidersConfigOverrides
}

export function parseProvidersConfig(value: unknown): ProvidersConfig {
  return createProvidersConfig(parseProvidersConfigOverrides(value))
}
