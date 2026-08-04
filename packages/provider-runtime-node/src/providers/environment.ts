import type { SupportedCoreCode } from '../spec/codes'
import type { HostEnvironmentSnapshot } from '@server/host-environment'
import { SERIALIZED_SHELL_CHILD_ENV } from '@server/shell-child-environment'
import { PROVIDER_OWNED_ENV_KEYS } from './owned-env'

/**
 * CodeTask-owned internal control keys that must not leak across launches.
 * authMode / outerSandbox travel on ProviderTurnContext, not env.
 */
export const CODETASK_TRANSIENT_ENV_KEYS = [
  'CODETASK_TASK_IDEMPOTENCY_KEY',
  'CODETASK_RUNTIME_ROOT',
  'MCP_BEARER_TOKEN',
  'CODETASK_OUTER_SANDBOX',
  'CODETASK_PROVIDER_AUTH_MODE',
  SERIALIZED_SHELL_CHILD_ENV
] as const

/**
 * Provider credentials and host-side provider configuration are never inherited
 * by a child process. Authentication comes from the selected CLI's login store;
 * product settings are passed through typed provider overlays.
 */
export const PROVIDER_HOST_ENV_DENYLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CURSOR_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'OPENCODE_API_KEY'
] as const

export const PROVIDER_AUTH_ENV_DENYLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CURSOR_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'OPENCODE_API_KEY'
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

export function stripProviderHostConfiguration(
  env: Readonly<Record<string, string>>
): Record<string, string> {
  const out = { ...env }
  const denied = new Set(PROVIDER_HOST_ENV_DENYLIST.map((key) => key.toLowerCase()))
  for (const key of Object.keys(out)) {
    if (denied.has(key.toLowerCase())) delete out[key]
  }
  return out
}

export function stripProviderAuthCredentials(
  env: Readonly<Record<string, string>>
): Record<string, string> {
  const out = { ...env }
  const denied = new Set(PROVIDER_AUTH_ENV_DENYLIST.map((key) => key.toLowerCase()))
  for (const key of Object.keys(out)) {
    if (denied.has(key.toLowerCase())) delete out[key]
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
    let env = stripProviderHostConfiguration(stripCodeTaskTransientEnv(input.hostEnvironment))
    env = applyProviderOverlay(input.provider, env, input.providerOverlay)

    if (input.taskOverlay) {
      env = { ...env, ...input.taskOverlay }
    }
    if (input.sandboxOverlay) {
      env = { ...env, ...input.sandboxOverlay }
    }

    return stripProviderAuthCredentials(env)
  }
}

/** Sole production EnvironmentCompiler instance. */
export const defaultEnvironmentCompiler: EnvironmentCompiler = new DefaultEnvironmentCompiler()
