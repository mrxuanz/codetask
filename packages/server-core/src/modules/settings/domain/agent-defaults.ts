import type { AgentDefaultsSettings, SettingsProviderCode } from '@codetask/contracts'
import { SettingsError } from './settings-errors.ts'
import { trySettingsProviderCode } from './setting-namespace.ts'

const DEFAULT_PROVIDER: SettingsProviderCode = 'cursor'

export function defaultAgentDefaultsSettings(): AgentDefaultsSettings {
  return {
    plannerProvider: DEFAULT_PROVIDER,
    sliceVerifierProvider: DEFAULT_PROVIDER,
    milestoneVerifierProvider: DEFAULT_PROVIDER
  }
}

function isSettingsProviderCode(value: unknown): value is SettingsProviderCode {
  return typeof value === 'string' && trySettingsProviderCode(value) !== null
}

export function parseAgentDefaultsSettings(value: unknown): AgentDefaultsSettings {
  const defaults = defaultAgentDefaultsSettings()
  if (value === undefined || value === null) return defaults
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw SettingsError.badRequest('settings.invalid_payload', 'agent_defaults must be an object')
  }

  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (
      key !== 'plannerProvider' &&
      key !== 'sliceVerifierProvider' &&
      key !== 'milestoneVerifierProvider'
    ) {
      throw SettingsError.badRequest('settings.invalid_payload', `Unknown field: ${key}`)
    }
  }

  return {
    plannerProvider:
      record.plannerProvider !== undefined
        ? requireSettingsProviderCode(record.plannerProvider, 'plannerProvider')
        : defaults.plannerProvider,
    sliceVerifierProvider:
      record.sliceVerifierProvider !== undefined
        ? requireSettingsProviderCode(record.sliceVerifierProvider, 'sliceVerifierProvider')
        : defaults.sliceVerifierProvider,
    milestoneVerifierProvider:
      record.milestoneVerifierProvider !== undefined
        ? requireSettingsProviderCode(record.milestoneVerifierProvider, 'milestoneVerifierProvider')
        : defaults.milestoneVerifierProvider
  }
}

function requireSettingsProviderCode(value: unknown, field: string): SettingsProviderCode {
  if (typeof value !== 'string') {
    throw SettingsError.badRequest('settings.provider_unknown', `Unknown provider for ${field}`)
  }
  const normalized = trySettingsProviderCode(value)
  if (!normalized) {
    throw SettingsError.badRequest('settings.provider_unknown', `Unknown provider for ${field}`)
  }
  return normalized
}

export function normalizeAgentDefaultsSettings(value: unknown): AgentDefaultsSettings {
  const parsed = parseAgentDefaultsSettings(value)
  return {
    plannerProvider: parsed.plannerProvider,
    sliceVerifierProvider: parsed.sliceVerifierProvider,
    milestoneVerifierProvider: parsed.milestoneVerifierProvider
  }
}

export function validateAgentDefaultsSettings(
  value: AgentDefaultsSettings,
  options?: { isProviderAvailable?: (code: SettingsProviderCode) => boolean }
): AgentDefaultsSettings {
  for (const code of [
    value.plannerProvider,
    value.sliceVerifierProvider,
    value.milestoneVerifierProvider
  ]) {
    if (!isSettingsProviderCode(code)) {
      throw SettingsError.badRequest('settings.provider_unknown', `Unknown provider: ${code}`)
    }
    if (options?.isProviderAvailable && !options.isProviderAvailable(code)) {
      throw SettingsError.badRequest(
        'settings.provider_unavailable',
        `Provider unavailable: ${code}`
      )
    }
  }
  return value
}
