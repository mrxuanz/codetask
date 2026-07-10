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
import { readSandboxChunks, readStderrPreview } from './stdout-reader'

interface JobCursorSandboxSession {
  jobId: string
  spawned: SpawnedSandboxWorker
  launched: LaunchedSandbox | null
  busy: boolean
}

const jobSessions = new Map<string, JobCursorSandboxSession>()

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
  const streamEnded = false

  const abort = (): void => terminateSandboxTree(handle)
  signal?.addEventListener('abort', abort, { once: true })

  try {
    throwIfSandboxTurnAborted(signal)

    const stdoutLines = readSandboxStdoutLines(handle, {
      keepReading: () => !streamEnded,
      pollExit: () => safePollSandboxExit(handle)
    })

    yield* readSandboxChunks(stdoutLines, {
      signal,
      stopOnDoneMarker: true,
      debugPrefix: 'job-cursor-pool'
    })

    const lineCount = 0
    const stderrPreview = readStderrPreview(handle)
    if (lineCount === 0) {
      sandboxTurnDebug('job-cursor-pool: no stdout before worker exit', {
        stderrPreview: stderrPreview.trim().slice(0, 500) || undefined
      })
      if (stderrPreview.trim()) {
        throw new SandboxError(stderrPreview.trim(), 'sandbox.sdk.error')
      }
      throw new SandboxError(
        'Cursor job worker exited without output (stdin may have been closed before turn input was sent)',
        'sandbox.sdk.error'
      )
    }
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

  const session: JobCursorSandboxSession = { jobId, spawned, launched: null, busy: false }
  jobSessions.set(jobId, session)
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
  handle.endStdin()
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
    jobId
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
  } finally {
    session.busy = false
    if (safePollSandboxExit(sessionHandle(session)) !== null) {
      jobSessions.delete(jobId)
    }
  }
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

export function resetJobCursorSandboxPoolForTests(): void {
  jobSessions.clear()
}
