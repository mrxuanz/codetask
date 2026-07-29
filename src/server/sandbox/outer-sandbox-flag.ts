import { processHostEnvironmentSource } from '../host-environment'
import { getRuntimeMode } from '../runtime-mode'

export function isOuterSandboxEnabled(): boolean {
  const hostEnv = processHostEnvironmentSource.snapshot()
  const mode = getRuntimeMode()
  if (mode === 'server' && hostEnv.CODETASK_DISABLE_OUTER_SANDBOX === '1') {
    console.warn(
      '[sandbox] CODETASK_DISABLE_OUTER_SANDBOX is ignored in server mode; outer sandbox stays enabled'
    )
  }
  if (mode === 'server') {
    return true
  }
  return hostEnv.CODETASK_DISABLE_OUTER_SANDBOX !== '1'
}
