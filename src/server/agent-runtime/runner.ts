import { join } from 'path'
import { isOuterSandboxEnabled, streamSandboxedConversationTurn } from '../sandbox'
import { SandboxError } from '../sandbox/types'
import type { SupportedCoreCode } from '../conversation/cores'
import { ensureIsolatedProviderDirs } from './env'
import { getAgentTurnProvider } from './providers'
import { isTestFakeProvider } from './providers/test-overrides'
import { roleRequiresOuterSandbox, resolveRoleMcpToolNames, type ConversationRole } from './roles'
import { compactTurnChunkForIpc } from './chunk-ipc'
import { streamWithTurnRetry } from './retry'
import { resolveUserMcpServersMap } from '../settings/mcp'
import type { AgentTurnChunk, AgentTurnRunnerInput, RoleWorkerInput } from './types'

export function ensureRuntimeRoot(dataDir: string, threadId: string, coreCode: string): string {
  const runtimeRoot = join(dataDir, 'runtimes', threadId, coreCode)
  ensureIsolatedProviderDirs(runtimeRoot)
  return runtimeRoot
}

export function ensureJobCursorRuntimeRoot(
  dataDir: string,
  threadId: string,
  jobId: string,
  coreCode: string
): string {
  const runtimeRoot = join(dataDir, 'runtimes', threadId, 'jobs', jobId, coreCode)
  ensureIsolatedProviderDirs(runtimeRoot)
  return runtimeRoot
}

export function ensureJobTaskRuntimeRoot(
  dataDir: string,
  threadId: string,
  jobId: string,
  taskId: string,
  coreCode: string
): string {
  const runtimeRoot = join(dataDir, 'runtimes', threadId, 'jobs', jobId, 'tasks', taskId, coreCode)
  ensureIsolatedProviderDirs(runtimeRoot)
  return runtimeRoot
}

export async function* streamAgentTurn(
  input: AgentTurnRunnerInput
): AsyncGenerator<AgentTurnChunk> {
  yield* streamWithTurnRetry(() => streamAgentTurnOnce(input), {
    signal: input.signal,
    label: `${input.role}/${input.provider}`
  })
}

export async function* streamConversationTurn(input: {
  role: ConversationRole
  coreCode: SupportedCoreCode
  workspaceRoot: string
  runtimeRoot: string
  prompt: string
  runtimeSessionId?: string | null
  model?: string
  systemPrompt?: string
  mcpUrl?: string
  mcpToolNames?: readonly string[]
  mcpToken?: string
  signal?: AbortSignal
}): AsyncGenerator<AgentTurnChunk> {
  yield* streamAgentTurn({ ...input, provider: input.coreCode })
}

async function* streamAgentTurnOnce(input: AgentTurnRunnerInput): AsyncGenerator<AgentTurnChunk> {
  const mcpToolNames = input.mcpToolNames ?? resolveRoleMcpToolNames(input.role)
  const provider = getAgentTurnProvider(input.provider)
  const useFakeInProcess = isTestFakeProvider(provider)
  const userMcpServers =
    input.userMcpServers ?? resolveUserMcpServersMap(input.provider, input.role)

  if (roleRequiresOuterSandbox(input.role) && !useFakeInProcess) {
    if (!isOuterSandboxEnabled()) {
      throw new SandboxError(
        `${input.role} must run inside the OS outer sandbox via the Agent SDK; CODETASK_DISABLE_OUTER_SANDBOX=1 is not allowed`,
        'sandbox.required'
      )
    }
    yield* streamSandboxedConversationTurn({
      role: input.role,
      coreCode: input.provider,
      workspaceRoot: input.workspaceRoot,
      runtimeRoot: input.runtimeRoot,
      prompt: input.prompt,
      runtimeSessionId: input.runtimeSessionId,
      model: input.model,
      systemPrompt: input.systemPrompt,
      mcpUrl: input.mcpUrl,
      mcpToolNames,
      userMcpServers,
      mcpToken: input.mcpToken,
      signal: input.signal,
      readRoots: input.readRoots,
      jobId: input.jobId
    })
    return
  }

  const workerInput: RoleWorkerInput = {
    provider: input.provider,
    role: input.role,
    cwd: input.workspaceRoot,
    runtimeRoot: input.runtimeRoot,
    prompt: input.prompt,
    runtimeSessionId: input.runtimeSessionId,
    model: input.model,
    systemPrompt: input.systemPrompt,
    mcpUrl: input.mcpUrl,
    mcpToolNames,
    userMcpServers,
    jobId: input.jobId
  }

  for await (const chunk of provider.streamTurn(workerInput, {
    outerSandbox: useFakeInProcess ? false : roleRequiresOuterSandbox(input.role),
    signal: input.signal
  })) {
    const compact = compactTurnChunkForIpc(input.role, chunk)
    if (compact) yield compact
  }
}
