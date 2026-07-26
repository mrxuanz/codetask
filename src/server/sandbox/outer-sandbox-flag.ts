import { getAppContext } from '../bootstrap'
import { resolveOuterSandboxEnabled } from './outer-sandbox-policy'

let warnedServerIgnoresDisable = false

/**
 * Whether the OS outer sandbox is required/enabled for this process.
 *
 * Reads AppContext / AppConfig only — never CODETASK_* host env flags.
 * Fail closed (enabled) when the runtime is not bootstrapped.
 */
export function isOuterSandboxEnabled(): boolean {
  let ctx: ReturnType<typeof getAppContext>
  try {
    ctx = getAppContext()
  } catch {
    // Not bootstrapped: fail closed — sandbox on.
    return true
  }

  const outerSandboxEnabled = ctx.config.sandbox.outerSandboxEnabled
  if (ctx.security.mode === 'server' && !outerSandboxEnabled && !warnedServerIgnoresDisable) {
    warnedServerIgnoresDisable = true
    console.warn(
      '[sandbox] sandbox.outerSandboxEnabled=false is ignored in server mode; outer sandbox stays enabled'
    )
  }

  return resolveOuterSandboxEnabled({
    mode: ctx.security.mode,
    outerSandboxEnabled
  })
}
