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
import { streamWithTurnRetry } from './retry'
import { resolveUserMcpServersMap } from '../settings/mcp'
import type { AgentTurnChunk, AgentTurnRunnerInput, RoleWorkerInput } from './types'
import { resolveDownstreamAbortSignal } from '../context/request-abort'
import { inspectJobRuntimeQuota, JobRuntimeQuotaExceededError } from '../runtime/cleanup'
import { getAppContext } from '../bootstrap'
import { readRetentionSettings } from '../retention/settings'

export function ensureRuntimeRoot(dataDir: string, threadId: string, coreCode: string): string {
  const runtimeRoot = join(dataPaths(dataDir).runtimes, threadId, coreCode)
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
  let quota:
    | {
        dataDir: string
        maxBytes: number
        abort: AbortController
        error: JobRuntimeQuotaExceededError | null
      }
    | undefined
  try {
    const ctx = getAppContext()
    const maxBytes = readRetentionSettings(ctx.settings).runtimeMaxBytesPerJob
    const inspected = await inspectJobRuntimeQuota({
      dataDir: ctx.dataDir,
      runtimeRoot: input.runtimeRoot,
      maxBytes
    })
    if (inspected.scope) {
      if (inspected.hardExceeded) {
        throw new JobRuntimeQuotaExceededError(inspected.scope.jobId, inspected.bytes, maxBytes)
      }
      quota = { dataDir: ctx.dataDir, maxBytes, abort: new AbortController(), error: null }
    }
  } catch (error) {
    if (error instanceof JobRuntimeQuotaExceededError) throw error
    // Unit-level/in-process Provider runs may not own an application context.
  }

  const guardedSignal = quota
    ? AbortSignal.any([...(signal ? [signal] : []), quota.abort.signal])
    : signal
  const downstreamInput =
    guardedSignal === input.signal ? input : { ...input, signal: guardedSignal }
  let checking = false
  const sampleMs = Math.max(250, Number(process.env.CODETASK_RUNTIME_QUOTA_SAMPLE_MS ?? 30_000))
  const timer = quota
    ? setInterval(() => {
        if (checking || quota!.error) return
        checking = true
        void inspectJobRuntimeQuota({
          dataDir: quota!.dataDir,
          runtimeRoot: input.runtimeRoot,
          maxBytes: quota!.maxBytes
        })
          .then((inspected) => {
            if (inspected.hardExceeded && inspected.scope) {
              quota!.error = new JobRuntimeQuotaExceededError(
                inspected.scope.jobId,
                inspected.bytes,
                quota!.maxBytes
              )
              quota!.abort.abort(quota!.error)
            }
          })
          .finally(() => {
            checking = false
          })
      }, sampleMs)
    : null
  timer?.unref?.()

  let streamFailed = false
  let streamFailure: unknown
  try {
    yield* streamWithTurnRetry(() => streamAgentTurnOnce(downstreamInput), {
      signal: guardedSignal,
      label: `${input.role}/${input.provider}`
    })
  } catch (error) {
    streamFailed = true
    streamFailure = error
  } finally {
    if (timer) clearInterval(timer)
    if (quota && !quota.error) {
      const inspected = await inspectJobRuntimeQuota({
        dataDir: quota.dataDir,
        runtimeRoot: input.runtimeRoot,
        maxBytes: quota.maxBytes
      })
      if (inspected.hardExceeded && inspected.scope) {
        quota.error = new JobRuntimeQuotaExceededError(
          inspected.scope.jobId,
          inspected.bytes,
          quota.maxBytes
        )
      }
    }
  }
  if (quota?.error) throw quota.error
  if (streamFailed) throw streamFailure
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
