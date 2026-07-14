import {
  applyTaskIdempotencyEnv,
  buildProviderChildEnv,
  buildSandboxPreparedProviderEnv
} from '../env'
import { buildCodexSdkConfig, type CodexSdkConfig } from '../mcp'
import type { AgentTurnInput } from '../types'
import { resolveProviderOuterSandbox } from '../provider-policy'
import { resolveRoleMcpToolNames, roleRequiresOuterSandbox, type ConversationRole } from '../roles'
import { createTurnError } from '../../../shared/turn-errors.ts'

export type CodexSandboxMode = 'danger-full-access' | 'workspace-write'

export interface CodexThreadOptions {
  model?: string
  workingDirectory: string
  skipGitRepoCheck: true
  approvalPolicy: 'never'
  sandboxMode: CodexSandboxMode
  networkAccessEnabled: true
  additionalDirectories?: string[]
}

export interface CodexTurnPlan {
  role: ConversationRole
  outerSandbox: boolean
  mcpToolNames: readonly string[] | undefined
  env: Record<string, string>
  sdkConfig: CodexSdkConfig | undefined
  threadOptions: CodexThreadOptions
}

export const resolveCodexOuterSandbox = resolveProviderOuterSandbox

export function resolveCodexMcpToolNamesForTurn(
  input: Pick<AgentTurnInput, 'role' | 'mcpToolNames'>
): readonly string[] | undefined {
  if (input.mcpToolNames?.length) return input.mcpToolNames
  return resolveRoleMcpToolNames(input.role)
}

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

  const sdkConfig = buildCodexSdkConfig({
    mcpUrl: input.mcpUrl,
    outerSandbox,
    mcpToolNames,
    userMcpServers: options.userMcpServers ?? {}
  })

  const env = outerSandbox
    ? buildSandboxPreparedProviderEnv()
    : buildProviderChildEnv(input.runtimeRoot, { preserveHostIdentity: true })
  applyTaskIdempotencyEnv(env, input.idempotencyKey)

  const sandboxMode: CodexSandboxMode = outerSandbox ? 'danger-full-access' : 'workspace-write'

  const threadOptions: CodexThreadOptions = {
    workingDirectory: input.cwd,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
    sandboxMode,
    networkAccessEnabled: true,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(outerSandbox ? {} : { additionalDirectories: [input.runtimeRoot] })
  }

  return {
    role: input.role,
    outerSandbox,
    mcpToolNames,
    env,
    sdkConfig,
    threadOptions
  }
}
