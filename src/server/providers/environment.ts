import type { SupportedCoreCode } from '../../shared/providers/codes'
import type { HostEnvironmentSnapshot } from '../host-environment'
import { PROVIDER_OWNED_ENV_KEYS } from './owned-env'

/**
 * CodeTask-owned internal control keys that must not leak across launches.
 * authMode / runtimeRoot / outerSandbox travel on ProviderTurnContext, not env.
 */
export const CODETASK_TRANSIENT_ENV_KEYS = [
  'CODETASK_TASK_IDEMPOTENCY_KEY',
  'CODETASK_RUNTIME_ROOT',
  'MCP_BEARER_TOKEN',
  'CODETASK_OUTER_SANDBOX',
  'CODETASK_PROVIDER_AUTH_MODE'
] as const

/**
 * Inputs for the single subprocess-environment compile boundary.
 * Host identity arrives as a snapshot; overlays are explicit declarations.
 */
export interface EnvironmentCompileInput {
  readonly provider: SupportedCoreCode
  readonly hostEnvironment: HostEnvironmentSnapshot
  readonly providerOverlay?: Readonly<Record<string, string>> | undefined
  readonly taskOverlay?: Readonly<Record<string, string>> | undefined
  readonly sandboxOverlay?: Readonly<Record<string, string>> | undefined
}

/**
 * Unique compiler that turns a host snapshot + overlays into a fresh child env.
 * Never reads or writes `process.env`.
 */
export interface EnvironmentCompiler {
  compile(input: EnvironmentCompileInput): Record<string, string>
}

/**
 * Strip CodeTask transient keys only. Host provider auth keys are preserved.
 */
export function stripCodeTaskTransientEnv(
  env: Readonly<Record<string, string>>
): Record<string, string> {
  const out = { ...env }
  for (const key of CODETASK_TRANSIENT_ENV_KEYS) {
    delete out[key]
  }
  return out
}

/**
 * Apply provider overlay, allowing only keys declared in catalog ownedEnvKeys.
 */
export function applyProviderOverlay(
  provider: SupportedCoreCode,
  env: Readonly<Record<string, string>>,
  overlay: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  if (!overlay) return { ...env }
  const owned = new Set(PROVIDER_OWNED_ENV_KEYS[provider])
  const out = { ...env }
  for (const [key, value] of Object.entries(overlay)) {
    if (!owned.has(key)) continue
    out[key] = value
  }
  return out
}

export class DefaultEnvironmentCompiler implements EnvironmentCompiler {
  compile(input: EnvironmentCompileInput): Record<string, string> {
    let env = stripCodeTaskTransientEnv(input.hostEnvironment)
    env = applyProviderOverlay(input.provider, env, input.providerOverlay)

    if (input.taskOverlay) {
      env = { ...env, ...input.taskOverlay }
    }
    if (input.sandboxOverlay) {
      env = { ...env, ...input.sandboxOverlay }
    }

    // Host-auth product decision: do not invent isolated CLI homes here.
    // Existing host CODEX_HOME / CLAUDE_CONFIG_DIR are preserved if present.
    return env
  }
}

/** Sole production EnvironmentCompiler instance. */
export const defaultEnvironmentCompiler: EnvironmentCompiler = new DefaultEnvironmentCompiler()
