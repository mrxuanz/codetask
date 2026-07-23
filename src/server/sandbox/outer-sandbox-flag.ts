import { processHostEnvironmentSource } from '../host-environment'

export function isOuterSandboxEnabled(): boolean {
  const hostEnv = processHostEnvironmentSource.snapshot()
  if (
    hostEnv.CODETASK_MODE === 'server' &&
    hostEnv.CODETASK_DISABLE_OUTER_SANDBOX === '1'
  ) {
    console.warn(
      '[sandbox] CODETASK_DISABLE_OUTER_SANDBOX is ignored in server mode; outer sandbox stays enabled'
    )
  }
  if (hostEnv.CODETASK_MODE === 'server') {
    return true
  }
  return hostEnv.CODETASK_DISABLE_OUTER_SANDBOX !== '1'
}
