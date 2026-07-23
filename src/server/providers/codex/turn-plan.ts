import {
  applyLoopbackNoProxyEnv,
  applyTaskIdempotencyEnv,
  buildProviderChildEnv,
  buildSandboxPreparedProviderEnv
} from '../../agent-runtime/env'
import { buildCodexSdkConfig, type CodexSdkConfig } from '../../agent-runtime/mcp'
import type { AgentTurnInput } from '../../agent-runtime/types'
import { resolveProviderOuterSandbox } from '../../agent-runtime/provider-policy'
import {
  resolveRoleMcpToolNames,
  roleRequiresOuterSandbox,
  type ConversationRole
} from '../../agent-runtime/roles'
import { createTurnError } from '../../../shared/turn-errors.ts'
import {
  capabilityProfileIsReadOnly,
  resolveInputCapabilityProfile
} from '../../agent-runtime/capabilities'
import { resolveProviderExecutable } from '../executable'

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
  /** Same installation path detect/discover resolved — passed to SDK codexPathOverride. */
  readonly codexPathOverride?: string | undefined
  readonly installationId?: string | undefined
}

export const resolveCodexOuterSandbox = resolveProviderOuterSandbox

export function resolveCodexMcpToolNamesForTurn(
  input: Pick<AgentTurnInput, 'role' | 'mcpToolNames'>
): readonly string[] | undefined {
  if (input.mcpToolNames?.length) return input.mcpToolNames
  return resolveRoleMcpToolNames(input.role)
}

/**
 * Prefer the driver-discovered installation; fall back to the shared resolver so
 * detect and SDK launch share one path identity.
 */
export function resolveCodexPathOverride(input: AgentTurnInput): {
  readonly codexPathOverride?: string
  readonly installationId?: string
} {
  if (input.installation) {
    return {
      codexPathOverride: input.installation.invocation.executable,
      installationId: input.installation.id
    }
  }
  const resolved = resolveProviderExecutable('codex')
  if (!resolved) return {}
  return {
    codexPathOverride: resolved.executable,
    installationId: resolved.installationId
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

  const env = outerSandbox
    ? buildSandboxPreparedProviderEnv()
    : buildProviderChildEnv(input.runtimeRoot, { preserveHostIdentity: true })
  if (input.mcpUrl) applyLoopbackNoProxyEnv(env)
  applyTaskIdempotencyEnv(env, input.idempotencyKey)

  const sandboxMode: CodexSandboxMode = outerSandbox
    ? 'danger-full-access'
    : readOnly
      ? 'read-only'
      : 'danger-full-access'

  const threadOptions: CodexThreadOptions = {
    workingDirectory: input.cwd,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    sandboxMode,
    networkAccessEnabled: !readOnly,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(!outerSandbox && !readOnly ? { additionalDirectories: [input.runtimeRoot] } : {})
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
