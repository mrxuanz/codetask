import { join } from 'path'
import { SandboxError } from '../sandbox/types'
import { isOuterSandboxEnabled } from '../sandbox/outer-sandbox-flag'
import type { SupportedCoreCode } from '../conversation/cores'
import { dataPaths, jobTaskRuntimeDirPath } from '../data-paths'
import { ensureIsolatedProviderDirs } from './env'
import { getAgentTurnProvider } from './providers'
import { getProviderRegistry } from '../providers/access'
import { isTestFakeProvider } from './providers/test-overrides'
import { resolveRoleMcpToolNames, type ConversationRole } from './roles'
import { compactTurnChunkForIpc } from './chunk-ipc'
import { resolveTurnMaxRetries, streamWithTurnRetry } from './retry'
import { resolveUserMcpServersMap } from '../settings/mcp'
import type { AgentTurnChunk, AgentTurnRunnerInput, RoleWorkerInput } from './types'
import { resolveDownstreamAbortSignal } from '../context/request-abort'
import { getAppConfig } from '../bootstrap'
import { getWorkspaceLeaseContext } from '../legacy-control-plane/workspace-lease-context'
import {
  isWorkspaceLeaseActive,
  refreshWorkspaceLease
} from '../legacy-control-plane/workspace-lease-store'
import { getExecutionRunContext } from '../legacy-control-plane/execution-run-context'
import {
  assertCapabilityProfileMatchesRole,
  assertProviderSupportsCapability,
  capabilityProfileIsReadOnly,
  capabilityProfileRequiresOuterSandbox,
  type AgentCapabilityProfile
} from './capabilities'

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

async function* withSandboxLeaseRefresh<T>(
  stream: AsyncGenerator<T>,
  input: {
    workloadRunId?: string
    workspaceLease?: { leaseId: string }
    controller: AbortController
    externalSignal?: AbortSignal
  }
): AsyncGenerator<T> {
  const KEEPALIVE_INTERVAL_MS = 60_000
  const { refreshWorkloadLease } = await import('../legacy-control-plane/workload-slot-store')
  let refreshPending = false
  const abortForLeaseLoss = (error: unknown): void => {
    const cause =
      error instanceof Error
        ? error
        : new SandboxError('Execution lease was lost', 'workspace.lease_lost')
    if (!input.controller.signal.aborted) input.controller.abort(cause)
  }
  const refresh = async (): Promise<void> => {
    if (refreshPending || input.controller.signal.aborted) return
    refreshPending = true
    try {
      if (input.workloadRunId) await refreshWorkloadLease(input.workloadRunId)
      if (input.workspaceLease && !refreshWorkspaceLease(input.workspaceLease.leaseId)) {
        throw new SandboxError('Workspace lease was lost', 'workspace.lease_lost')
      }
    } catch (error) {
      abortForLeaseLoss(error)
    } finally {
      refreshPending = false
    }
  }
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    void refresh()
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

  if (input.externalSignal) {
    input.externalSignal.addEventListener('abort', cleanup, { once: true })
  }

  try {
    for await (const chunk of stream) {
      yield chunk
    }
    if (input.controller.signal.aborted) {
      throw input.controller.signal.reason instanceof Error
        ? input.controller.signal.reason
        : new SandboxError('Sandbox turn was aborted', 'workspace.lease_lost')
    }
  } finally {
    cleanup()
    input.externalSignal?.removeEventListener('abort', cleanup)
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
  capabilityProfile: AgentCapabilityProfile
}): AsyncGenerator<AgentTurnChunk> {
  yield* streamAgentTurn({ ...input, provider: input.coreCode })
}

async function* streamAgentTurnOnce(input: AgentTurnRunnerInput): AsyncGenerator<AgentTurnChunk> {
  const mcpToolNames = input.mcpToolNames ?? resolveRoleMcpToolNames(input.role)
  const provider = getAgentTurnProvider(input.provider)
  const useFakeInProcess = isTestFakeProvider(provider)
  const driver = useFakeInProcess ? null : getProviderRegistry().get(input.provider)
  const workspaceLease = input.workspaceLease ?? getWorkspaceLeaseContext()
  const workloadRunId = input.workloadRunId ?? getExecutionRunContext()?.runId
  assertCapabilityProfileMatchesRole(input.role, input.capabilityProfile)
  if (!useFakeInProcess) {
    assertProviderSupportsCapability(input.provider, input.capabilityProfile)
  }
  const installation = driver ? ((await driver.discover()) ?? undefined) : undefined
  if (driver && !installation) {
    throw new Error(`${driver.descriptor.label} is disabled or no executable was found`)
  }
  const providerSettings = driver?.settings
  const userMcpServers = capabilityProfileIsReadOnly(input.capabilityProfile)
    ? {}
    : (input.userMcpServers ?? resolveUserMcpServersMap(input.provider, input.role))

  if (input.capabilityProfile === 'chat-write' && input.workspaceAccess !== 'exclusive-write') {
    throw new SandboxError(
      'chat-write requires an exclusive workspace lease',
      'workspace.lease_lost'
    )
  }

  if (input.capabilityProfile === 'task-sandbox' && input.workspaceAccess !== 'exclusive-write') {
    throw new SandboxError(
      'task-worker requires an exclusive workspace lease',
      'workspace.lease_required'
    )
  }

  if (input.workspaceAccess === 'exclusive-write') {
    const lease = workspaceLease
    if (
      !lease ||
      !isWorkspaceLeaseActive({
        leaseId: lease.leaseId,
        ownerKind: lease.ownerKind,
        ownerId: lease.ownerId,
        workspacePath: input.workspaceRoot
      })
    ) {
      throw new SandboxError(
        'Workspace write access requires an active matching lease',
        'workspace.lease_required'
      )
    }
  }

  if (capabilityProfileRequiresOuterSandbox(input.capabilityProfile) && !useFakeInProcess) {
    if (!isOuterSandboxEnabled()) {
      throw new SandboxError(
        `${input.role} must run inside the OS outer sandbox via the Agent SDK; CODETASK_DISABLE_OUTER_SANDBOX=1 is not allowed`,
        'sandbox.required'
      )
    }
    const { streamSandboxedConversationTurn } = await import('../sandbox/orchestrator')
    const sandboxAbort = new AbortController()
    const abortSandbox = (): void => {
      if (!sandboxAbort.signal.aborted) sandboxAbort.abort(input.signal?.reason)
    }
    input.signal?.addEventListener('abort', abortSandbox, { once: true })
    if (input.signal?.aborted) abortSandbox()
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
      signal: sandboxAbort.signal,
      readRoots: input.readRoots,
      jobId: input.jobId,
      providerRuntimeScopeId: input.providerRuntimeScopeId,
      idempotencyKey: input.idempotencyKey,
      workspaceAccess: input.workspaceAccess,
      capabilityProfile: input.capabilityProfile,
      installation: installation!,
      providerSettings: providerSettings!
    })
    try {
      yield* withSandboxLeaseRefresh(sandboxStream, {
        workloadRunId,
        workspaceLease,
        controller: sandboxAbort,
        externalSignal: input.signal
      })
    } finally {
      input.signal?.removeEventListener('abort', abortSandbox)
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
    capabilityProfile: input.capabilityProfile,
    installation,
    providerSettings,
    jobId: input.jobId,
    providerRuntimeScopeId: input.providerRuntimeScopeId,
    workloadRunId: input.workloadRunId,
    idempotencyKey: input.idempotencyKey
  }

  for await (const chunk of provider.streamTurn(workerInput, {
    outerSandbox: useFakeInProcess
      ? false
      : capabilityProfileRequiresOuterSandbox(input.capabilityProfile),
    signal: input.signal
  })) {
    const compact = compactTurnChunkForIpc(input.role, chunk)
    if (compact) yield compact
  }
}
