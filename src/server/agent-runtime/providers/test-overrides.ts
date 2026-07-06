import type { SupportedCoreCode } from '../../conversation/cores'
import type { AgentTurnProvider } from '../types'

let testProviderOverrides: Partial<Record<SupportedCoreCode, AgentTurnProvider>> | null = null

export function setTestAgentTurnProviders(
  overrides: Partial<Record<SupportedCoreCode, AgentTurnProvider>>
): void {
  testProviderOverrides = { ...overrides }
}

export function resetTestAgentTurnProviders(): void {
  testProviderOverrides = null
}

export function getTestAgentTurnProviderOverride(
  code: SupportedCoreCode
): AgentTurnProvider | undefined {
  return testProviderOverrides?.[code]
}

export function isTestFakeProvider(provider: AgentTurnProvider): boolean {
  return provider.protocol === 'fake'
}

export function isTestFakeAgentModeActive(): boolean {
  return testProviderOverrides !== null && Object.keys(testProviderOverrides).length > 0
}

let taskEvidenceWaitTimeoutMs: number | undefined

export function setTaskEvidenceWaitTimeoutForTests(ms: number | undefined): void {
  taskEvidenceWaitTimeoutMs = ms
}

export function getTaskEvidenceWaitTimeoutForTests(): number | undefined {
  return taskEvidenceWaitTimeoutMs
}
