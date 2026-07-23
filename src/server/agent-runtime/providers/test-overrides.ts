import type { SupportedCoreCode } from '../../conversation/cores'
import type { AgentTurnProvider } from '../types'
import { getProviderRegistry } from '../../providers/access'
import { createTestOverrideDriver } from '../../providers/delegating-driver'
import type { ProviderRegistry } from '../../providers/registry'

let testProviderRegistry: ProviderRegistry | null = null

export function setTestAgentTurnProviders(
  overrides: Partial<Record<SupportedCoreCode, AgentTurnProvider>>
): void {
  const base = getProviderRegistry()
  const drivers = Object.entries(overrides).map(([code, provider]) =>
    createTestOverrideDriver(base.get(code as SupportedCoreCode), provider as AgentTurnProvider)
  )
  testProviderRegistry = base.withOverrides(drivers)
}

export function resetTestAgentTurnProviders(): void {
  testProviderRegistry = null
}

export function getTestProviderRegistryOverride(): ProviderRegistry | null {
  return testProviderRegistry
}

export function isTestFakeProvider(provider: AgentTurnProvider): boolean {
  return provider.protocol === 'fake'
}

export function isTestFakeAgentModeActive(): boolean {
  return testProviderRegistry !== null
}

let taskEvidenceWaitTimeoutMs: number | undefined

export function setTaskEvidenceWaitTimeoutForTests(ms: number | undefined): void {
  taskEvidenceWaitTimeoutMs = ms
}

export function getTaskEvidenceWaitTimeoutForTests(): number | undefined {
  return taskEvidenceWaitTimeoutMs
}
