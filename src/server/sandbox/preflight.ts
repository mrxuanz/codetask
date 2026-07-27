import { sandboxTurnDebug } from '../debug/sandbox-turn'
import { assertSandboxReadyForExecution } from './health'

export function preflightSandbox(): void {
  sandboxTurnDebug('preflightSandbox: checking sandbox health')
  assertSandboxReadyForExecution()
  sandboxTurnDebug('preflightSandbox: ok')
}

export { getSandboxHealth, sandboxBootstrapInfo, assertSandboxReadyForExecution } from './health'
export type { SandboxHealthReport, SandboxHealthStatus } from './health'
