import {
  applyLoopbackNoProxyEnv,
  buildProviderChildEnv,
  buildSandboxPreparedProviderEnv
} from '@server/agent-runtime/env'
import { buildCodexSdkConfig, type CodexSdkConfig } from '@server/agent-runtime/mcp'
import type { AgentTurnInput } from '@server/agent-runtime/types'
import { resolveProviderOuterSandbox } from '@server/agent-runtime/provider-policy'
import {
  resolveRoleMcpToolNames,
  roleRequiresOuterSandbox,
  type ConversationRole
} from '@server/agent-runtime/roles'
import { createTurnError } from '@shared/turn-errors/index.ts'
import {
  capabilityProfileIsReadOnly,
  resolveInputCapabilityProfile
} from '@server/agent-runtime/capabilities'
import { resolveProviderExecutable } from '../executable'
import {
  resolveProviderExecutableStrategy,
  type ProviderExecutableStrategy
} from '../runtime-executable'

export type CodexSandboxMode = 'danger-full-access' | 'workspace-write' | 'read-only'

export interface CodexThreadOptions {
  model?: string
  workingDirectory: string
  skipGitRepoCheck: true
  approvalPolicy: 'never'
  sandboxMode: CodexSandboxMode
  networkAccessEnabled: boolean
  additionalDirectories?: string[]
}

export interface CodexTurnPlan {
  role: ConversationRole
  outerSandbox: boolean
  mcpToolNames: readonly string[] | undefined
  env: Record<string, string>
  sdkConfig: CodexSdkConfig | undefined
  threadOptions: CodexThreadOptions
  /** Present only when the user explicitly configured an executable path. */
  readonly codexPathOverride?: string | undefined
  readonly installationId?: string | undefined
  readonly executableStrategy: ProviderExecutableStrategy
}

export const resolveCodexOuterSandbox = resolveProviderOuterSandbox

export function resolveCodexMcpToolNamesForTurn(
  input: Pick<AgentTurnInput, 'role' | 'mcpToolNames'>
): readonly string[] | undefined {
  if (input.mcpToolNames?.length) return input.mcpToolNames
  return resolveRoleMcpToolNames(input.role)
}

/** Use the SDK-bundled native CLI unless the user explicitly selected a path. */
export function resolveCodexPathOverride(input: AgentTurnInput): {
  readonly codexPathOverride?: string
  readonly installationId?: string
  readonly executableStrategy: ProviderExecutableStrategy
} {
  if (input.installation) {
    const executableStrategy = resolveProviderExecutableStrategy('codex', input.installation.source)
    if (executableStrategy === 'sdk-bundled') {
      return {
        installationId: input.installation.id,
        executableStrategy
      }
    }
    return {
      codexPathOverride: input.installation.invocation.executable,
      installationId: input.installation.id,
      executableStrategy
    }
  }
  const resolved = resolveProviderExecutable('codex')
  if (!resolved) return { executableStrategy: 'sdk-bundled' }
  const executableStrategy = resolveProviderExecutableStrategy('codex', resolved.source)
  if (executableStrategy === 'sdk-bundled') {
    return {
      installationId: resolved.installationId,
      executableStrategy
    }
  }
  return {
    codexPathOverride: resolved.executable,
    installationId: resolved.installationId,
    executableStrategy
  }
}

/** CodexDriver-owned turn plan builder (PRU-07-05). */
export function buildCodexTurnPlan(
  input: AgentTurnInput,
  options: {
    outerSandbox?: boolean | undefined
    userMcpServers?: Record<string, unknown> | undefined
  } = {}
): CodexTurnPlan {
  const outerSandbox = resolveCodexOuterSandbox(input.role, options.outerSandbox)
  if (!outerSandbox && roleRequiresOuterSandbox(input.role)) {
    throw createTurnError('sandbox.required', {
      detail: 'Codex full-access requires OS outer sandbox'
    })
  }
  const mcpToolNames = resolveCodexMcpToolNamesForTurn(input)
  const capabilityProfile = resolveInputCapabilityProfile(input)
  const readOnly = capabilityProfileIsReadOnly(capabilityProfile)
  const pathOverride = resolveCodexPathOverride(input)

  const sdkConfig = buildCodexSdkConfig({
    mcpUrl: input.mcpUrl,
    outerSandbox,
    mcpToolNames,
    userMcpServers: options.userMcpServers ?? {}
  })

  const env = outerSandbox ? buildSandboxPreparedProviderEnv() : buildProviderChildEnv()
  if (input.mcpUrl) applyLoopbackNoProxyEnv(env)

  const sandboxMode: CodexSandboxMode = outerSandbox
    ? 'danger-full-access'
    : readOnly
      ? 'read-only'
      : 'workspace-write'

  const threadOptions: CodexThreadOptions = {
    workingDirectory: input.cwd,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    sandboxMode,
    networkAccessEnabled: !readOnly,
    ...(input.model !== undefined ? { model: input.model } : {})
  }

  return {
    role: input.role,
    outerSandbox,
    mcpToolNames,
    env,
    sdkConfig,
    threadOptions,
    ...pathOverride
  }
}
