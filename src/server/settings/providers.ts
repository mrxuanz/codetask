import {
  createProvidersConfig,
  parseProvidersConfigOverrides,
  type ProvidersConfig
} from '../../shared/providers/settings'
import { getAppContext } from '../bootstrap'

export interface ProviderSettingsPayload {
  readonly providers: ProvidersConfig
  readonly revision: number
  readonly applyMode: 'restart'
}

export function loadProviderSettings(): ProviderSettingsPayload {
  const current = getAppContext().settings.readNamespace('provider_runtime')
  const overrides = parseProvidersConfigOverrides(current.value?.providers ?? current.value ?? {})
  return {
    providers: createProvidersConfig(overrides),
    revision: current.revision,
    applyMode: 'restart'
  }
}

export function saveProviderSettings(
  overrides: unknown,
  expectedRevision?: number
): ProviderSettingsPayload {
  const providers = createProvidersConfig(parseProvidersConfigOverrides(overrides))
  const revision = getAppContext().settings.writeNamespace(
    'provider_runtime',
    { providers: structuredClone(providers) },
    expectedRevision === undefined ? {} : { expectedRevision }
  )
  return { providers, revision, applyMode: 'restart' }
}
