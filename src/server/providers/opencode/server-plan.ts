import type { Config } from '@opencode-ai/sdk/v2'
import {
  applyTaskIdempotencyEnv,
  buildProviderChildEnv,
  buildSandboxPreparedProviderEnv
} from '../../agent-runtime/env'
import { buildOpencodeMcpServers } from '../../agent-runtime/mcp'
import {
  capabilityProfileIsReadOnly,
  resolveInputCapabilityProfile
} from '../../agent-runtime/capabilities'
import { roleRequiresOuterSandbox } from '../../agent-runtime/roles'
import type { AgentTurnInput } from '../../agent-runtime/types'
import {
  resolveOpencodePermissionConfig,
  resolveOpencodeToolsConfig
} from '../../agent-runtime/providers/opencode-config'
import { createTurnError } from '../../../shared/turn-errors.ts'
import { resolveProviderExecutable } from '../executable'

/**
 * Prefer the driver-discovered installation; fall back to the shared resolver so
 * detect and server launch share one path identity.
 */
export function resolveOpenCodePathOverride(input: AgentTurnInput): {
  readonly executable: string
  readonly prefixArgs: readonly string[]
  readonly installationId?: string
} {
  if (input.installation) {
    return {
      executable: input.installation.invocation.executable,
      prefixArgs: input.installation.invocation.prefixArgs,
      installationId: input.installation.id
    }
  }
  const resolved = resolveProviderExecutable('opencode')
  if (resolved) {
    return {
      executable: resolved.executable,
      prefixArgs: resolved.prefixArgs,
      installationId: resolved.installationId
    }
  }
  return {
    executable: 'opencode',
    prefixArgs: []
  }
}

export function buildOpenCodeConfig(input: AgentTurnInput): Config {
  const userMcpServers = input.userMcpServers ?? {}
  const capabilityProfile = resolveInputCapabilityProfile(input)
  const readOnly = capabilityProfileIsReadOnly(capabilityProfile)

  const mcpEntries = buildOpencodeMcpServers(input.mcpUrl, userMcpServers)
  const mcp = Object.keys(mcpEntries).length > 0 ? (mcpEntries as Config['mcp']) : undefined

  return {
    permission: resolveOpencodePermissionConfig(capabilityProfile),
    tools: resolveOpencodeToolsConfig(capabilityProfile),
    ...(readOnly ? { plugin: [], instructions: [] } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(mcp ? { mcp } : {})
  }
}

export interface OpenCodeServerPlan {
  readonly hostname: '127.0.0.1'
  readonly pure: boolean
  readonly logLevel: string | undefined
  readonly config: Config
  readonly env: Record<string, string>
  readonly cwd: string
  readonly executable: string
  readonly prefixArgs: readonly string[]
  readonly installationId: string | undefined
  readonly outerSandbox: boolean
  /** CLI args after the binary (serve + flags). Port is filled at launch. */
  buildServeArgs(port: number): readonly string[]
}

/** OpenCodeDriver-owned local-server launch plan (PRU-09-05). */
export function buildOpenCodeServerPlan(
  input: AgentTurnInput,
  options: { outerSandbox?: boolean | undefined } = {}
): OpenCodeServerPlan {
  const outerSandbox = options.outerSandbox ?? false
  if (!outerSandbox && roleRequiresOuterSandbox(input.role)) {
    throw createTurnError('sandbox.required', {
      detail: 'OpenCode requires OS outer sandbox'
    })
  }

  const capabilityProfile = resolveInputCapabilityProfile(input)
  const pure = capabilityProfileIsReadOnly(capabilityProfile)
  const config = buildOpenCodeConfig(input)
  const pathOverride = resolveOpenCodePathOverride(input)
  const env = outerSandbox
    ? buildSandboxPreparedProviderEnv()
    : buildProviderChildEnv(input.runtimeRoot, { preserveHostIdentity: true })
  applyTaskIdempotencyEnv(env, input.idempotencyKey)

  const logLevel =
    typeof config.logLevel === 'string' && config.logLevel.trim()
      ? config.logLevel.trim()
      : undefined

  return {
    hostname: '127.0.0.1',
    pure,
    logLevel,
    config,
    env,
    cwd: input.cwd,
    executable: pathOverride.executable,
    prefixArgs: pathOverride.prefixArgs,
    installationId: pathOverride.installationId,
    outerSandbox,
    buildServeArgs(port: number): readonly string[] {
      const args = ['serve', `--hostname=127.0.0.1`, `--port=${port}`]
      if (pure) args.push('--pure')
      if (logLevel) args.push(`--log-level=${logLevel}`)
      return args
    }
  }
}
