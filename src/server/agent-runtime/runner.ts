import { join } from 'path'
import { isOuterSandboxEnabled, streamSandboxedConversationTurn } from '../sandbox'
import { SandboxError } from '../sandbox/types'
import type { SupportedCoreCode } from '../conversation/cores'
import { dataPaths, jobTaskRuntimeDirPath } from '../data-paths'
import { ensureIsolatedProviderDirs } from './env'
import { getAgentTurnProvider } from './providers'
import { isTestFakeProvider } from './providers/test-overrides'
import { roleRequiresOuterSandbox, resolveRoleMcpToolNames, type ConversationRole } from './roles'
import { compactTurnChunkForIpc } from './chunk-ipc'
import { resolveTurnMaxRetries, streamWithTurnRetry } from './retry'
import { resolveUserMcpServersMap } from '../settings/mcp'
import type { AgentTurnChunk, AgentTurnRunnerInput, RoleWorkerInput } from './types'
import { resolveDownstreamAbortSignal } from '../context/request-abort'
import { getAppConfig } from '../bootstrap'

export function ensureRuntimeRoot(dataDir: string, threadId: string, coreCode: string): string {
  const runtimeRoot = join(dataPaths(dataDir).runtimes, threadId, coreCode)
  ensureIsolatedProviderDirs(runtimeRoot)
  return runtimeRoot
}

/**
 * Conversation Cursor (and other providers) isolate chat vs create-task state.
 * Path: runtimes/<threadId>/<kind>/<coreCode>
 */
export function ensureConversationRuntimeRoot(
  dataDir: string,
  threadId: string,
  kind: 'chat' | 'create_task',
  coreCode: string
): string {
  const runtimeRoot = join(dataPaths(dataDir).runtimes, threadId, kind, coreCode)
  ensureIsolatedProviderDirs(runtimeRoot)
  return runtimeRoot
}

export function ensureJobRuntimeRoot(
  dataDir: string,
  threadId: string,
  jobId: string,
  coreCode: string
): string {
  const runtimeRoot = join(dataPaths(dataDir).runtimes, threadId, 'jobs', jobId, coreCode)
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
  const runtimeRoot = join(jobTaskRuntimeDirPath(dataDir, threadId, jobId, taskId), coreCode)
  ensureIsolatedProviderDirs(runtimeRoot)
  return runtimeRoot
}

async function* withWorkloadLeaseRefresh<T>(
  stream: AsyncGenerator<T>,
  workloadRunId: string,
  signal?: AbortSignal
): AsyncGenerator<T> {
  const KEEPALIVE_INTERVAL_MS = 60_000
  const { refreshWorkloadLease } = await import('../legacy-control-plane/workload-slot-store')
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    refreshWorkloadLease(workloadRunId).catch((error) => {
      console.warn('[keepalive] lease refresh failed', workloadRunId, error)
    })
  }, KEEPALIVE_INTERVAL_MS)

  if (timer && typeof timer.unref === 'function') {
    timer.unref()
  }

  const cleanup = (): void => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  if (signal) {
    signal.addEventListener('abort', cleanup, { once: true })
  }

  try {
    for await (const chunk of stream) {
      yield chunk
    }
  } finally {
    cleanup()
  }
}

export async function* streamAgentTurn(
  input: AgentTurnRunnerInput
): AsyncGenerator<AgentTurnChunk> {
  const signal = resolveDownstreamAbortSignal(input.signal)
  const downstreamInput = signal === input.signal ? input : { ...input, signal }
  yield* streamWithTurnRetry(() => streamAgentTurnOnce(downstreamInput), {
    signal,
    maxAttempts: resolveTurnMaxRetries(getAppConfig().turn.maxRetries),
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
    const sandboxStream = streamSandboxedConversationTurn({
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
      jobId: input.jobId,
      idempotencyKey: input.idempotencyKey
    })
    if (input.workloadRunId) {
      yield* withWorkloadLeaseRefresh(sandboxStream, input.workloadRunId, input.signal)
    } else {
      yield* sandboxStream
    }
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
    jobId: input.jobId,
    workloadRunId: input.workloadRunId,
    idempotencyKey: input.idempotencyKey
  }

  for await (const chunk of provider.streamTurn(workerInput, {
    outerSandbox: useFakeInProcess ? false : roleRequiresOuterSandbox(input.role),
    signal: input.signal
  })) {
    const compact = compactTurnChunkForIpc(input.role, chunk)
    if (compact) yield compact
  }
}
