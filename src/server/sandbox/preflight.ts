import { sandboxTurnDebug } from '../debug/sandbox-turn'
import { assertSandboxReadyForExecution } from './health'

export function preflightSandbox(): void {
  if (process.env.CODETASK_DISABLE_OUTER_SANDBOX === '1') {
    sandboxTurnDebug('preflightSandbox: skipped (CODETASK_DISABLE_OUTER_SANDBOX=1)')
    return
  }
  sandboxTurnDebug('preflightSandbox: checking sandbox health')
  assertSandboxReadyForExecution()
  sandboxTurnDebug('preflightSandbox: ok')
}

export { getSandboxHealth, sandboxBootstrapInfo, assertSandboxReadyForExecution } from './health'
export type { SandboxHealthReport, SandboxHealthStatus } from './health'
