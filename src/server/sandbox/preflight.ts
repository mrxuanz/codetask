import { sandboxTurnDebug } from '../debug/sandbox-turn'
import { assertSandboxReadyForExecution } from './health'
import { isOuterSandboxEnabled } from './outer-sandbox-flag'

export function preflightSandbox(): void {
  if (!isOuterSandboxEnabled()) {
    sandboxTurnDebug('preflightSandbox: skipped (outer sandbox disabled)')
    return
  }
  sandboxTurnDebug('preflightSandbox: checking sandbox health')
  assertSandboxReadyForExecution()
  sandboxTurnDebug('preflightSandbox: ok')
}

export { getSandboxHealth, sandboxBootstrapInfo, assertSandboxReadyForExecution } from './health'
export type { SandboxHealthReport, SandboxHealthStatus } from './health'
