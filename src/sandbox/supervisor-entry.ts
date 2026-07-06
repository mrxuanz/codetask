import {
  isSupervisorCommand,
  type SupervisorCommand,
  type SupervisorEvent
} from './supervisor-protocol'
import { compactTurnChunkForIpc } from '../server/agent-runtime/chunk-ipc'
import { streamSandboxedConversationTurnLocal } from '../server/sandbox/orchestrator-local'
import { SandboxError } from '../server/sandbox/types'
import { closeJobCursorSandbox } from '../server/sandbox/job-cursor-pool'
import { sandboxTurnDebug } from '../server/debug/sandbox-turn'

interface ActiveTurn {
  controller: AbortController
  jobId?: string
}

const activeSessions = new Map<string, ActiveTurn>()

function send(event: SupervisorEvent): void {
  if (typeof process.send === 'function') {
    process.send(event)
  }
}

function handleCommand(command: SupervisorCommand): void {
  switch (command.type) {
    case 'ping':
      send({ type: 'pong' })
      break
    case 'shutdown':
      for (const active of activeSessions.values()) {
        active.controller.abort()
      }
      activeSessions.clear()
      process.exit(0)
      break
    case 'cancel': {
      const active = activeSessions.get(command.sessionId)
      active?.controller.abort()
      activeSessions.delete(command.sessionId)
      break
    }
    case 'cancel-job-turns': {
      const jobId = command.jobId.trim()
      if (!jobId) break
      for (const [sessionId, active] of activeSessions) {
        if (active.jobId === jobId) {
          active.controller.abort()
          activeSessions.delete(sessionId)
        }
      }
      break
    }
    case 'start-turn':
      sandboxTurnDebug('supervisor-entry: start-turn received', {
        sessionId: command.sessionId,
        coreCode: command.input.coreCode,
        role: command.input.role
      })
      void runTurn(command.sessionId, command.input)
      break
    case 'close-job-cursor':
      void closeJobCursorSandbox(command.jobId).catch((error) => {
        sandboxTurnDebug('supervisor-entry: close-job-cursor failed', {
          jobId: command.jobId,
          message: error instanceof Error ? error.message : String(error)
        })
      })
      break
    default:
      break
  }
}

async function runTurn(
  sessionId: string,
  input: Parameters<typeof streamSandboxedConversationTurnLocal>[0]
): Promise<void> {
  const controller = new AbortController()
  activeSessions.set(sessionId, { controller, jobId: input.jobId?.trim() || undefined })

  send({ type: 'session-state', sessionId, state: 'starting' })

  sandboxTurnDebug('supervisor-entry: runTurn begin', {
    sessionId,
    coreCode: input.coreCode,
    role: input.role
  })

  try {
    send({ type: 'session-state', sessionId, state: 'running' })

    let chunkCount = 0
    for await (const chunk of streamSandboxedConversationTurnLocal({
      ...input,
      signal: controller.signal
    })) {
      chunkCount += 1
      if (chunkCount <= 2 || chunk.type === 'completed') {
        sandboxTurnDebug('supervisor-entry: forwarding chunk', {
          sessionId,
          chunkCount,
          type: chunk.type
        })
      }
      const ipcChunk = compactTurnChunkForIpc(input.role, chunk)
      if (ipcChunk) {
        send({ type: 'chunk', sessionId, chunk: ipcChunk })
      }
      if (chunk.type === 'completed') break
      if (chunk.type === 'error') {
        throw new SandboxError(chunk.message, 'sandbox.sdk.error')
      }
    }

    send({ type: 'session-state', sessionId, state: 'completed' })
    send({ type: 'exit', sessionId, code: 0, status: 'exited' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sandboxTurnDebug('supervisor-entry: runTurn failed', {
      sessionId,
      message,
      stack: error instanceof Error ? error.stack?.slice(0, 400) : undefined
    })
    const status =
      error instanceof SandboxError && error.code === 'sandbox.turn.cancelled'
        ? 'cancelled'
        : error instanceof SandboxError && error.code === 'sandbox.turn.timed_out'
          ? 'timed_out'
          : 'failed'

    send({
      type: 'session-state',
      sessionId,
      state: status === 'cancelled' ? 'cancelled' : 'failed'
    })
    send({
      type: 'exit',
      sessionId,
      code: -1,
      status,
      stderr: message
    })
  } finally {
    activeSessions.delete(sessionId)
  }
}

if (typeof process.send !== 'function') {
  console.error('[sandbox-supervisor] must be started with IPC (fork)')
  process.exit(1)
}

process.on('message', (message: unknown) => {
  if (!isSupervisorCommand(message)) {
    send({ type: 'error', message: 'invalid supervisor command' })
    return
  }
  handleCommand(message)
})

process.on('uncaughtException', (error) => {
  console.error('[sandbox-supervisor] uncaughtException:', error)
  send({ type: 'error', message: error.message })
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  console.error('[sandbox-supervisor] unhandledRejection:', reason)
  send({ type: 'error', message })
  process.exit(1)
})

send({ type: 'ready' })
