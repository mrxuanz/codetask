import type { SupportedCoreCode } from '../conversation/cores'
import type { ConversationRole } from '../agent-runtime/roles'
import type { AgentTurnInput, AgentTurnChunk } from '../agent-runtime/types'
import { formatSdkTurnError } from '../agent-runtime/errors'
import { sandboxTurnDebug } from '../debug/sandbox-turn'
import { resolveSandboxDataDir } from './data-dir'
import { buildSandboxEnv } from './env'
import {
  awaitSandboxWorkerAttestation,
  launchSandboxedWorker,
  pollSandboxExit,
  readSandboxStdoutLines,
  reapSandboxChild,
  terminateSandboxTree
} from './launcher'
import {
  policyForRole,
  applyProviderWriteRoots,
  applyProviderReadRoots,
  collectPolicyReadRoots,
  collectPolicyWriteRoots
} from './policy'
import { resolveMainSandboxScript } from './packaged-paths'
import { preflightSandbox } from './preflight'
import { prepareProviderAuth, runProviderAuthPreflight } from './provider-auth'
import { mergeProviderReadRoots, resolveProviderReadRoots } from './provider-read-roots'
import { resolveRuntimeReadRoots } from './runtime-read-roots'
import { DEFAULT_SANDBOX_TURN_TIMEOUT_MS } from './session-state'
import { SandboxError } from './types'
import { sandboxErrorFromErrorChunk, readStderrPreview } from './stdout-reader'
import { streamJobCursorSandboxTurn } from './job-cursor-pool'
import { throwIfSandboxTurnAborted } from './turn-guards'
export interface RunSandboxedTurnInput {
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
  userMcpServers?: Record<string, unknown>
  mcpToken?: string
  signal?: AbortSignal
  readRoots?: string[]
  jobId?: string
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

  sandboxTurnDebug('sandbox orchestrator: readWorkerJsonl start')

  const abort = (): void => terminateSandboxTree(handle)
  signal?.addEventListener('abort', abort, { once: true })

  let exitResult: { code: number | null; status: string } | undefined
  try {
    let lineCount = 0
    for await (const line of readSandboxStdoutLines(handle, {
      keepReading: () => !streamEnded,
      pollExit: () => pollSandboxExit(handle)
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
      yield chunk
      if (chunk.type === 'completed') {
        streamEnded = true
        break
      }
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
    jobId: input.jobId
  }

  const workerPath = resolveRoleWorkerPath()

  const authPrepared = prepareProviderAuth(input.coreCode, input.runtimeRoot, {
    workspaceRoot: input.workspaceRoot
  })
  throwIfSandboxTurnAborted(input.signal)
  runProviderAuthPreflight(input.coreCode, authPrepared)
  throwIfSandboxTurnAborted(input.signal)

  const dataDir = resolveSandboxDataDir()
  const providerReadRoots = mergeProviderReadRoots(resolveProviderReadRoots(input.coreCode), [
    ...authPrepared.readRoots,
    dataDir,
    ...resolveRuntimeReadRoots(),
    ...(input.readRoots ?? [])
  ])

  const policy = applyProviderReadRoots(
    applyProviderWriteRoots(
      policyForRole({
        role: input.role,
        workspaceRoot: input.workspaceRoot,
        runtimeRoot: input.runtimeRoot
      }),
      authPrepared.writeRoots
    ),
    providerReadRoots
  )

  sandboxTurnDebug('sandbox orchestrator: provider auth prepared', {
    provider: input.coreCode,
    mode: authPrepared.diagnostics.mode,
    authPresent: authPrepared.diagnostics.authMaterialPresent,
    warnings: authPrepared.diagnostics.warnings
  })

  const env = buildSandboxEnv({
    runtimeRoot: input.runtimeRoot,
    dataDir,
    providerEnv: authPrepared.envPatch,
    mcpToken: input.mcpToken
  })
  const readRoots = collectPolicyReadRoots(policy)
  const writeRoots = collectPolicyWriteRoots(policy)

  const useJobCursorPool =
    process.platform !== 'win32' &&
    input.coreCode === 'cursorcli' &&
    Boolean(input.jobId?.trim()) &&
    input.role === 'task-worker'

  try {
    if (useJobCursorPool) {
      throwIfSandboxTurnAborted(input.signal)
      yield* streamJobCursorSandboxTurn(input.jobId!, input, {
        policy,
        env,
        readRoots,
        writeRoots
      })
      return
    }

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

export function isOuterSandboxEnabled(): boolean {
  return process.env.CODETASK_DISABLE_OUTER_SANDBOX !== '1'
}
