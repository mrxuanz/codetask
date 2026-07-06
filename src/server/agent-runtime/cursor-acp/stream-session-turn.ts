import type { AgentTurnInput, AgentTurnChunk, AgentTurnOptions } from '../types'
import { buildCursorTurnPlan } from '../providers/cursor-policy'
import { probeCursorAgentAuth } from './errors'
import { createTurnError } from '../../../shared/turn-errors.ts'
import { resolveCursorAgentExecutable, resolveCursorAgentCommand } from './command'
import {
  buildConversationCursorRuntimeScope,
  buildCursorRuntimeKey,
  buildJobCursorRuntimeKey,
  buildTaskMcpProfile,
  createCursorSessionRuntime,
  getCursorProviderRuntimeRegistry
} from './runtime-registry'
import { materializeCursorMcpApprovals, removeInvalidCursorCliConfig } from './cursor-workspace'
import { debugCursor } from './acp-shared'
import type { CursorPromptInput } from './session-runtime'
import { shouldInvalidateCursorScopedRuntime } from './turn-guards'

export interface StreamCursorSessionTurnInput extends AgentTurnInput {
  jobId?: string
}

export async function* streamCursorSessionTurn(
  input: StreamCursorSessionTurnInput,
  options?: AgentTurnOptions
): AsyncGenerator<AgentTurnChunk> {
  const userMcpServers = input.userMcpServers ?? {}
  const plan = buildCursorTurnPlan(input, {
    outerSandbox: options?.outerSandbox,
    userMcpServers
  })
  const command = resolveCursorAgentCommand()
  const executable = resolveCursorAgentExecutable(command, plan.env)
  const authIssue = probeCursorAgentAuth(executable, plan.env)
  if (authIssue) {
    throw createTurnError(authIssue.code, {
      params: authIssue.params,
      detail: authIssue.detail ?? undefined
    })
  }

  removeInvalidCursorCliConfig(input.cwd)
  if (plan.mcpServers.length > 0) {
    const approvals = materializeCursorMcpApprovals({
      cwd: input.cwd,
      servers: plan.mcpServers,
      env: plan.env
    })
    if (approvals) {
      debugCursor('materialized MCP approvals', {
        path: approvals.approvalsPath,
        servers: plan.mcpServers.map((server) => server.name)
      })
    }
  }

  const runtimeOptions = {
    cwd: input.cwd,
    env: plan.env,
    cliArgs: plan.cliArgs
  }

  const mcpProfile = buildTaskMcpProfile(input.mcpUrl)
  const runtimeScopeId = input.jobId?.trim() || ''
  const ephemeral = !runtimeScopeId

  let runtime
  let registryKey: string | null = null
  if (ephemeral) {
    runtime = createCursorSessionRuntime(runtimeOptions)
  } else {
    registryKey = buildCursorRuntimeKey({
      scopeId: runtimeScopeId,
      provider: input.provider,
      workspaceRoot: input.cwd,
      model: input.model,
      mcpProfile
    })
    runtime = await getCursorProviderRuntimeRegistry().getOrCreate(
      registryKey,
      runtimeScopeId,
      () => createCursorSessionRuntime(runtimeOptions)
    )
  }

  const promptInput: CursorPromptInput = {
    role: input.role,
    cwd: input.cwd,
    prompt: input.prompt,
    systemPrompt: input.systemPrompt,
    model: input.model,
    mcpServers: plan.mcpServers,
    runtimeSessionId: input.runtimeSessionId,
    signal: options?.signal
  }

  try {
    yield* runtime.prompt(promptInput)
  } catch (error) {
    if (registryKey && shouldInvalidateCursorScopedRuntime(input.role, runtimeScopeId, error)) {
      await getCursorProviderRuntimeRegistry().invalidate(registryKey)
    }
    throw error
  } finally {
    if (ephemeral) {
      await runtime.close().catch(() => {})
    } else if (registryKey) {
      getCursorProviderRuntimeRegistry().touch(registryKey)
    }
  }
}

export async function closeJobCursorRuntime(jobId: string): Promise<void> {
  await getCursorProviderRuntimeRegistry().invalidateJob(jobId)
}

export async function closeCursorRuntimeScope(scopeId: string): Promise<void> {
  await getCursorProviderRuntimeRegistry().invalidateScope(scopeId)
}

export async function closeConversationCursorRuntime(threadId: string): Promise<void> {
  await Promise.all([
    closeCursorRuntimeScope(buildConversationCursorRuntimeScope(threadId, 'chat')),
    closeCursorRuntimeScope(buildConversationCursorRuntimeScope(threadId, 'create_task')),
    closeCursorRuntimeScope(`conversation:${threadId}`)
  ])
}

export async function invalidateJobCursorRuntimeKey(
  input: JobCursorRuntimeKeyInput
): Promise<void> {
  const key = buildJobCursorRuntimeKey(input)
  await getCursorProviderRuntimeRegistry().invalidate(key)
}

export type JobCursorRuntimeKeyInput = {
  jobId: string
  provider: string
  workspaceRoot: string
  model?: string
  mcpProfile: string
}
