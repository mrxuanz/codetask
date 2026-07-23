import type { SupportedCoreCode } from '../conversation/cores'
import type { ConversationRole } from '../agent-runtime/roles'
import type { AgentTurnInput, AgentTurnChunk } from '../agent-runtime/types'
import { formatSdkTurnError } from '../agent-runtime/errors'
import { sandboxTurnDebug } from '../debug/sandbox-turn'
import { buildLaunchSpec } from '../providers/launch-env'
import { buildSandboxEnv } from './env'
import {
  awaitSandboxWorkerAttestation,
  launchSandboxedWorker,
  pollSandboxExit,
  readSandboxStdoutLines,
  reapSandboxChild
} from './launcher'
import { policyForRoleV2, collectPolicyReadRoots, collectPolicyWriteRoots } from './policy'
import { resolveMainSandboxScript } from './packaged-paths'
import { preflightSandbox } from './preflight'
import { toProviderAuthLogDto } from './provider-auth/types'
import { mergeProviderReadRoots, resolveHostToolchainReadRoots } from './provider-read-roots'
import { resolveRuntimeReadRoots } from './runtime-read-roots'
import { DEFAULT_SANDBOX_TURN_TIMEOUT_MS } from './session-state'
import { SandboxError } from './types'
import { sandboxErrorFromErrorChunk, readStderrPreview } from './stdout-reader'
import { throwIfSandboxTurnAborted } from './turn-guards'
import type { WorkspaceAccessMode } from '../../shared/workspace-access.ts'
import type { AgentCapabilityProfile } from '../agent-runtime/capabilities'
import type { ProviderInstallation } from '../../shared/providers/installation'
import type { ProviderSettings } from '../../shared/providers/settings'
import { processHostEnvironmentSource } from '../host-environment'
export { isOuterSandboxEnabled } from './outer-sandbox-flag'

export interface RunSandboxedTurnInput {
  role: ConversationRole
  coreCode: SupportedCoreCode
  workspaceRoot: string
  runtimeRoot: string
  prompt: string
  runtimeSessionId?: string | null | undefined
  model?: string | undefined
  systemPrompt?: string | undefined
  mcpUrl?: string | undefined
  mcpToolNames?: readonly string[] | undefined
  userMcpServers?: Record<string, unknown> | undefined
  mcpToken?: string | undefined
  signal?: AbortSignal | undefined
  readRoots?: string[] | undefined
  jobId?: string | undefined
  providerRuntimeScopeId?: string | undefined
  idempotencyKey?: string | undefined
  workspaceAccess?: WorkspaceAccessMode | undefined
  capabilityProfile: AgentCapabilityProfile
  /** Selected in the application process and preserved through supervisor IPC. */
  installation: ProviderInstallation
  /** Typed settings snapshot paired with `installation`. */
  providerSettings: ProviderSettings
}

function resolveRoleWorkerPath(): string {
  const worker = resolveMainSandboxScript('role-worker.js')
  if (worker) return worker
  throw new SandboxError(
    'role-worker not built; run `npm run build` first',
    'sandbox.worker.missing'
  )
}

async function* readWorkerJsonl(
  handle: Awaited<ReturnType<typeof launchSandboxedWorker>>['handle'],
  signal?: AbortSignal
): AsyncGenerator<AgentTurnChunk> {
  let stderr = ''
  let streamEnded = false
  let sdkFailed = false
  let completed: Extract<AgentTurnChunk, { type: 'completed' }> | null = null

  sandboxTurnDebug('sandbox orchestrator: readWorkerJsonl start')

  // Keep the native handle open until the finally block reaps it. Closing it from
  // the abort listener can make a concurrent stdout poll lose the only observable
  // child-exit signal and strand the async iterator.
  const abort = (): void => handle.kill()
  signal?.addEventListener('abort', abort, { once: true })

  let exitResult: { code: number | null; status: string } | undefined
  try {
    let lineCount = 0
    for await (const line of readSandboxStdoutLines(handle, {
      keepReading: () => !streamEnded,
      pollExit: () => pollSandboxExit(handle),
      signal
    })) {
      lineCount += 1
      if (lineCount <= 3) {
        sandboxTurnDebug('sandbox orchestrator: stdout line', {
          lineCount,
          preview: line.slice(0, 120)
        })
      }
      const chunk = JSON.parse(line) as AgentTurnChunk
      if (chunk.type === 'error') {
        sdkFailed = true
        throw sandboxErrorFromErrorChunk(chunk)
      }
      if (chunk.type === 'completed') {
        completed = chunk
        streamEnded = true
        break
      }
      yield chunk
    }
    sandboxTurnDebug('sandbox orchestrator: stdout drained', { lineCount })
    if (lineCount === 0) {
      const stderrPreview = readStderrPreview(handle)
      if (stderrPreview.trim()) {
        sandboxTurnDebug('sandbox orchestrator: stderr preview', {
          stderr: stderrPreview.trim().slice(0, 2000)
        })
        throw new SandboxError(
          formatSdkTurnError(new Error(stderrPreview.trim())),
          'sandbox.sdk.error'
        )
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    sandboxTurnDebug('sandbox orchestrator: reaping child after stdout read')
    exitResult = await reapSandboxChild(handle, {
      signal,
      maxWaitMs: 5_000
    })
    sandboxTurnDebug('sandbox orchestrator: child reaped', {
      code: exitResult.code,
      status: exitResult.status
    })
    stderr += readStderrPreview(handle)
    handle.close()
  }

  if (exitResult && !sdkFailed) {
    if (exitResult.status === 'cancelled') {
      throw new SandboxError('sandbox turn cancelled', 'sandbox.turn.cancelled')
    }
    if (exitResult.status === 'timed_out') {
      throw new SandboxError(
        `sandbox turn timed out after ${DEFAULT_SANDBOX_TURN_TIMEOUT_MS}ms`,
        'sandbox.turn.timed_out'
      )
    }
    if (exitResult.code !== 0 && exitResult.code !== null) {
      const detail = formatSdkTurnError(new Error(stderr.trim() || '(no stderr output)'))
      const hint =
        exitResult.code === -1 && !stderr.trim()
          ? ' — Windows sandbox child exited abnormally; confirm `npm run build:sandbox` and restart the app'
          : ''
      throw new SandboxError(
        `sandbox worker exited ${exitResult.code}: ${detail}${hint}`,
        'sandbox.worker.exit'
      )
    }
  }

  if (completed) {
    yield completed
  }
}

export async function* streamSandboxedConversationTurnLocal(
  input: RunSandboxedTurnInput
): AsyncGenerator<AgentTurnChunk> {
  sandboxTurnDebug('sandbox orchestrator(local): begin turn', {
    role: input.role,
    coreCode: input.coreCode,
    workspaceRoot: input.workspaceRoot,
    runtimeRoot: input.runtimeRoot,
    hasMcpUrl: Boolean(input.mcpUrl),
    extraReadRoots: input.readRoots?.length ?? 0
  })

  throwIfSandboxTurnAborted(input.signal)
  if (process.platform === 'win32') {
    const { ensureWindowsSandboxReady } = await import('./windows-bootstrap')
    await ensureWindowsSandboxReady(input.runtimeRoot)
  }
  preflightSandbox()
  throwIfSandboxTurnAborted(input.signal)

  const workerInput: AgentTurnInput = {
    provider: input.coreCode,
    role: input.role,
    cwd: input.workspaceRoot,
    runtimeRoot: input.runtimeRoot,
    prompt: input.prompt,
    runtimeSessionId: input.runtimeSessionId,
    model: input.model,
    systemPrompt: input.systemPrompt,
    mcpUrl: input.mcpUrl,
    mcpToolNames: input.mcpToolNames,
    userMcpServers: input.userMcpServers,
    capabilityProfile: input.capabilityProfile,
    installation: input.installation,
    providerSettings: input.providerSettings,
    jobId: input.jobId,
    providerRuntimeScopeId: input.providerRuntimeScopeId,
    idempotencyKey: input.idempotencyKey
  }

  const workerPath = resolveRoleWorkerPath()

  // The supervisor process uses the same Driver implementation, while the
  // installation/settings snapshot itself comes from the application process.
  const { getProviderRegistry } = await import('../providers/access')
  const driver = getProviderRegistry().get(input.coreCode)
  const hostEnvironment = processHostEnvironmentSource.snapshot()
  const authPrepared = driver.prepareAuth({
    runtimeRoot: input.runtimeRoot,
    workspaceRoot: input.workspaceRoot,
    hostEnvironment
  })
  throwIfSandboxTurnAborted(input.signal)

  // PRU-11-06 / PRU-11-08: preflight + sandbox roots come from the Registry driver.
  const installation = input.installation
  if (installation.provider !== input.coreCode) {
    throw new SandboxError(
      `Provider installation mismatch: expected ${input.coreCode}, got ${installation.provider}`,
      'sandbox.sdk.error'
    )
  }
  await driver.preflight({ installation, preparedAuth: authPrepared })
  throwIfSandboxTurnAborted(input.signal)

  try {
    const launchSpec = buildLaunchSpec(input.coreCode, {
      cwd: input.workspaceRoot,
      env: authPrepared.envPatch,
      providerOverlay: authPrepared.envPatch,
      installation,
      providerSettings: input.providerSettings
    })
    sandboxTurnDebug('launch-spec', { summary: launchSpec.redactedSummary })
  } catch {
    // Executable may be unresolved here; the worker launch path will surface the error.
  }

  const contribution = driver.contributeSandboxPolicy({
    installation,
    preparedAuth: authPrepared,
    hostEnvironment
  })
  const providerReadRoots = mergeProviderReadRoots(
    [...contribution.readRoots, ...resolveHostToolchainReadRoots(hostEnvironment)],
    [...resolveRuntimeReadRoots(hostEnvironment), ...(input.readRoots ?? [])]
  )

  // WorkspaceAccessMode is enforced by the effective OS policy, not only by admission metadata.
  // Conversation/planner roles can read the project and write runtime/provider state only;
  // task-worker remains the sole role that may write the real workspace.
  const policy = policyForRoleV2({
    role: input.role,
    workspaceRoot: input.workspaceRoot,
    runtimeRoot: input.runtimeRoot,
    providerReadRoots,
    ...(contribution.writeRoots.length > 0
      ? { providerWriteRoots: [...contribution.writeRoots] }
      : {}),
    ...(input.readRoots ? { attachmentReadRoots: input.readRoots } : {}),
    ...(input.workspaceAccess ? { workspaceAccess: input.workspaceAccess } : {})
  })

  sandboxTurnDebug(
    'sandbox orchestrator: provider auth prepared',
    toProviderAuthLogDto(authPrepared.diagnostics)
  )

  const env = buildSandboxEnv({
    runtimeRoot: input.runtimeRoot,
    providerEnv: { ...contribution.environment },
    mcpToken: input.mcpToken
  })
  const readRoots = collectPolicyReadRoots(policy)
  const writeRoots = collectPolicyWriteRoots(policy)

  try {
    // Every provider turn, including Cursor task work, owns a fresh sandbox worker.
    // Keeping Cursor ACP alive across tasks allowed a wedged permission service to poison the
    // remainder of the job. Verification already uses this one-shot lifecycle.
    const spawned = await launchSandboxedWorker({
      policy,
      command: process.execPath,
      args: [workerPath],
      env,
      readRoots,
      writeRoots,
      signal: input.signal
    })

    const handle = spawned.handle
    handle.writeStdin(Buffer.from(JSON.stringify(workerInput), 'utf8'))
    handle.endStdin()
    awaitSandboxWorkerAttestation(spawned)

    yield* readWorkerJsonl(handle, input.signal)
  } finally {
    authPrepared.cleanupPlan()
  }
}
