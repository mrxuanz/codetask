import type { AgentTurnChunk } from '../agent-runtime/types'
import { sandboxTurnDebug } from '../debug/sandbox-turn'
import { SandboxError, type AnySandboxPolicy } from './types'
import {
  awaitSandboxWorkerAttestation,
  launchSandboxedWorker,
  readSandboxStdoutLines,
  reapSandboxChild,
  terminateSandboxTree,
  type LaunchedSandbox,
  type SpawnedSandboxWorker
} from './launcher'
import { resolveMainSandboxScript } from './packaged-paths'
import type { RunSandboxedTurnInput } from './orchestrator-local'
import { safePollSandboxExit, throwIfSandboxTurnAborted } from './turn-guards'
import { readSandboxChunks } from './stdout-reader'

interface JobCursorSandboxSession {
  jobId: string
  spawned: SpawnedSandboxWorker
  launched: LaunchedSandbox | null
  busy: boolean
  lastUsedAt: number
}

const jobSessions = new Map<string, JobCursorSandboxSession>()
const CONVERSATION_IDLE_MS = 30 * 60 * 1000
const CONVERSATION_SWEEP_MS = 5 * 60 * 1000
let conversationSweepTimer: ReturnType<typeof setInterval> | null = null

function isConversationScope(scopeId: string): boolean {
  return scopeId.startsWith('conversation:')
}

function ensureConversationPoolReaperStarted(): void {
  if (conversationSweepTimer) return
  conversationSweepTimer = setInterval(() => {
    void sweepIdleConversationCursorSandboxes().catch((error) => {
      sandboxTurnDebug('cursor sandbox pool reaper failed', {
        message: error instanceof Error ? error.message : String(error)
      })
    })
  }, CONVERSATION_SWEEP_MS)
  conversationSweepTimer.unref?.()
}

function resolveJobCursorWorkerPath(): string {
  const worker = resolveMainSandboxScript('role-worker-cursor-job.js')
  if (worker) return worker
  throw new SandboxError(
    'role-worker-cursor-job not built; run `npm run build` first',
    'sandbox.worker.missing'
  )
}

function discardJobCursorSession(jobId: string, session?: JobCursorSandboxSession): void {
  if (session) {
    terminateSandboxTree(sessionHandle(session))
  }
  jobSessions.delete(jobId)
}

async function* readTurnChunks(
  handle: LaunchedSandbox['handle'],
  signal?: AbortSignal
): AsyncGenerator<AgentTurnChunk> {
  const abort = (): void => terminateSandboxTree(handle)
  signal?.addEventListener('abort', abort, { once: true })

  try {
    throwIfSandboxTurnAborted(signal)

    const stdoutLines = readSandboxStdoutLines(handle, {
      keepReading: () => true,
      pollExit: () => safePollSandboxExit(handle)
    })

    yield* readSandboxChunks(stdoutLines, {
      signal,
      stopOnDoneMarker: true,
      stopOnCompleted: false,
      bufferCompletedUntilDoneMarker: true,
      debugPrefix: 'job-cursor-pool'
    })
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

async function launchJobCursorSession(
  jobId: string,
  bootstrap: RunSandboxedTurnInput & {
    policy: AnySandboxPolicy
    env: Record<string, string>
    readRoots: string[]
    writeRoots: string[]
  }
): Promise<JobCursorSandboxSession> {
  const workerPath = resolveJobCursorWorkerPath()
  sandboxTurnDebug('job-cursor-pool: launch persistent worker', { jobId, workerPath })

  const spawned = await launchSandboxedWorker({
    policy: bootstrap.policy,
    command: process.execPath,
    args: [workerPath],
    env: bootstrap.env,
    readRoots: bootstrap.readRoots,
    writeRoots: bootstrap.writeRoots,
    signal: bootstrap.signal
  })

  const session: JobCursorSandboxSession = {
    jobId,
    spawned,
    launched: null,
    busy: false,
    lastUsedAt: Date.now()
  }
  jobSessions.set(jobId, session)
  if (isConversationScope(jobId)) ensureConversationPoolReaperStarted()
  return session
}

function sessionHandle(session: JobCursorSandboxSession): SpawnedSandboxWorker['handle'] {
  return session.launched?.handle ?? session.spawned.handle
}

async function ensureJobCursorWorkerStarted(
  session: JobCursorSandboxSession,
  firstLine: string
): Promise<void> {
  if (session.launched) return

  const handle = session.spawned.handle
  handle.writeStdin(Buffer.from(`${firstLine}\n`, 'utf8'))
  // Keep stdin open: this worker owns the long-lived Cursor ACP scope and accepts later Turns.
  session.launched = awaitSandboxWorkerAttestation(session.spawned)
  sandboxTurnDebug('job-cursor-pool: persistent worker started', { jobId: session.jobId })
}

export async function* streamJobCursorSandboxTurn(
  jobId: string,
  input: RunSandboxedTurnInput,
  bootstrap: {
    policy: AnySandboxPolicy
    env: Record<string, string>
    readRoots: string[]
    writeRoots: string[]
  }
): AsyncGenerator<AgentTurnChunk> {
  throwIfSandboxTurnAborted(input.signal)

  let session = jobSessions.get(jobId)
  const exitCode = session ? safePollSandboxExit(sessionHandle(session)) : null
  if (!session || exitCode !== null) {
    if (session) {
      sandboxTurnDebug('job-cursor-pool: discarding stale worker', { jobId, exitCode })
      discardJobCursorSession(jobId, session)
    }
    session = await launchJobCursorSession(jobId, { ...input, ...bootstrap })
  }

  if (session.busy) {
    throw new SandboxError(`job ${jobId} Cursor worker is busy`, 'sandbox.worker.busy')
  }
  session.busy = true
  session.lastUsedAt = Date.now()

  const workerInput = {
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
    jobId,
    idempotencyKey: input.idempotencyKey
  }

  const turnLine = JSON.stringify(workerInput)
  try {
    throwIfSandboxTurnAborted(input.signal)
    const handle = sessionHandle(session)
    if (!session.launched) {
      await ensureJobCursorWorkerStarted(session, turnLine)
    } else {
      handle.writeStdin(Buffer.from(`${turnLine}\n`, 'utf8'))
    }
    if (session.launched) {
      yield* readTurnChunks(handle, input.signal)
    }
  } catch (error) {
    discardJobCursorSession(jobId, session)
    throw error
  } finally {
    session.busy = false
    session.lastUsedAt = Date.now()
    if (
      jobSessions.get(jobId) === session &&
      safePollSandboxExit(sessionHandle(session)) !== null
    ) {
      jobSessions.delete(jobId)
    }
  }
}

export async function sweepIdleConversationCursorSandboxes(
  now = Date.now(),
  idleMs = CONVERSATION_IDLE_MS
): Promise<number> {
  let closed = 0
  for (const [scopeId, session] of [...jobSessions]) {
    if (!isConversationScope(scopeId) || session.busy) continue
    if (now - session.lastUsedAt < idleMs) continue
    await closeJobCursorSandbox(scopeId)
    closed += 1
  }
  return closed
}

export async function closeJobCursorSandbox(jobId: string): Promise<void> {
  const session = jobSessions.get(jobId)
  if (!session) return
  jobSessions.delete(jobId)
  const handle = sessionHandle(session)
  if (session.launched) {
    try {
      handle.writeStdin(Buffer.from('{"type":"_close"}\n', 'utf8'))
    } catch {
      // ignore
    }
  }
  await reapSandboxChild(handle, { maxWaitMs: 5_000 }).catch(() => {})
  terminateSandboxTree(handle)
  sandboxTurnDebug('job-cursor-pool: closed', { jobId })
}

export async function closeAllJobCursorSandboxes(): Promise<void> {
  for (const scopeId of [...jobSessions.keys()]) {
    await closeJobCursorSandbox(scopeId).catch(() => {})
  }
  if (conversationSweepTimer) {
    clearInterval(conversationSweepTimer)
    conversationSweepTimer = null
  }
}

export function resetJobCursorSandboxPoolForTests(): void {
  jobSessions.clear()
  if (conversationSweepTimer) {
    clearInterval(conversationSweepTimer)
    conversationSweepTimer = null
  }
}
