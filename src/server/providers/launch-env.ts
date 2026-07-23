import type { SupportedCoreCode } from '../../shared/providers/codes'
import {
  applyProviderOverlay,
  CODETASK_TRANSIENT_ENV_KEYS,
  defaultEnvironmentCompiler,
  stripCodeTaskTransientEnv
} from './environment'
import { PROVIDER_OWNED_ENV_KEYS } from './owned-env'
import type {
  EnvVarSource,
  LaunchContext,
  LaunchEnvVarSummary,
  LaunchSpec,
  LaunchSummary,
  ResolvedExecutable
} from './types'
import { resolveProviderExecutable } from './executable'
import { processHostEnvironmentSource } from '../host-environment'

export { CODETASK_TRANSIENT_ENV_KEYS, applyProviderOverlay, stripCodeTaskTransientEnv }

type StringEnv = NodeJS.ProcessEnv | Record<string, string | undefined>

/**
 * Shallow-copy host environment into a new plain object.
 * Never mutates process.env.
 */
export function snapshotHostEnv(
  env: StringEnv = processHostEnvironmentSource.snapshot()
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * Assemble a fresh child-process env via the unique EnvironmentCompiler.
 * Optional hostEnv is snapshotted first; the compiler never touches process.env.
 */
export function buildLaunchEnv(input: {
  provider: SupportedCoreCode
  hostEnv?: StringEnv | undefined
  providerOverlay?: Record<string, string> | undefined
  taskOverlay?: Record<string, string> | undefined
  sandboxOverlay?: Record<string, string> | undefined
}): Record<string, string> {
  return defaultEnvironmentCompiler.compile({
    provider: input.provider,
    hostEnvironment: snapshotHostEnv(input.hostEnv ?? processHostEnvironmentSource.snapshot()),
    providerOverlay: input.providerOverlay,
    taskOverlay: input.taskOverlay,
    sandboxOverlay: input.sandboxOverlay
  })
}

function summarizeEnvVars(
  env: Record<string, string>,
  provider: SupportedCoreCode,
  overlays: {
    providerOverlay?: Record<string, string> | undefined
    taskOverlay?: Record<string, string> | undefined
    sandboxOverlay?: Record<string, string> | undefined
  }
): LaunchEnvVarSummary[] {
  const owned = PROVIDER_OWNED_ENV_KEYS[provider]
  const names = new Set<string>([
    ...owned,
    ...Object.keys(overlays.providerOverlay ?? {}),
    ...Object.keys(overlays.taskOverlay ?? {}),
    ...Object.keys(overlays.sandboxOverlay ?? {})
  ])

  const summaries: LaunchEnvVarSummary[] = []
  for (const name of [...names].sort()) {
    let source: EnvVarSource = 'host'
    if (overlays.sandboxOverlay && name in overlays.sandboxOverlay) source = 'sandbox'
    else if (overlays.taskOverlay && name in overlays.taskOverlay) source = 'task'
    else if (overlays.providerOverlay && name in overlays.providerOverlay) {
      source = 'provider-overlay'
    }
    summaries.push({
      name,
      source,
      present: Boolean(env[name])
    })
  }
  return summaries
}

export function buildLaunchSummary(input: {
  provider: SupportedCoreCode
  resolved: ResolvedExecutable
  cwd: string
  env: Record<string, string>
  providerOverlay?: Record<string, string> | undefined
  taskOverlay?: Record<string, string> | undefined
  sandboxOverlay?: Record<string, string> | undefined
}): LaunchSummary {
  return {
    provider: input.provider,
    executable: input.resolved.executable,
    executableSource: input.resolved.source,
    cwd: input.cwd,
    envVars: summarizeEnvVars(input.env, input.provider, {
      providerOverlay: input.providerOverlay,
      taskOverlay: input.taskOverlay,
      sandboxOverlay: input.sandboxOverlay
    })
  }
}

/**
 * Minimal LaunchSpec builder: resolved executable + assembled env + optional args.
 * Provider-specific CLI args are filled by adapters over time (H5-02..05).
 */
export function buildLaunchSpec(provider: SupportedCoreCode, context: LaunchContext): LaunchSpec {
  const resolved = context.installation
    ? {
        command: context.installation.command,
        executable: context.installation.invocation.executable,
        source: context.installation.source,
        installationId: context.installation.id,
        prefixArgs: context.installation.invocation.prefixArgs
      }
    : resolveProviderExecutable(provider, {
        env: context.env ?? processHostEnvironmentSource.snapshot(),
        settings: context.providerSettings
      })
  if (!resolved) {
    throw new Error(`Unable to resolve executable for provider: ${provider}`)
  }

  const env = buildLaunchEnv({
    provider,
    hostEnv: context.env,
    providerOverlay: context.providerOverlay,
    taskOverlay: context.taskOverlay,
    sandboxOverlay: context.sandboxOverlay
  })

  const redactedSummary = buildLaunchSummary({
    provider,
    resolved,
    cwd: context.cwd,
    env,
    providerOverlay: context.providerOverlay,
    taskOverlay: context.taskOverlay,
    sandboxOverlay: context.sandboxOverlay
  })

  return {
    installationId: resolved.installationId,
    executable: resolved.executable,
    args: [...resolved.prefixArgs, ...(context.args ? [...context.args] : [])],
    cwd: context.cwd,
    env,
    redactedSummary
  }
}
