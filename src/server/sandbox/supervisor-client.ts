import { randomUUID } from 'crypto'
import type { AgentTurnChunk } from '../agent-runtime/types'
import { sandboxTurnDebug } from '../debug/sandbox-turn'
import { SandboxError } from './types'
import type { RunSandboxedTurnInput } from './orchestrator-local'
import { getSandboxSupervisorManager } from './supervisor-manager'
import type { SupervisorEvent } from '../../sandbox/supervisor-protocol'
import { sandboxErrorFromErrorChunk } from './stdout-reader'
import { CLIENT_CANCEL_DRAIN_TIMEOUT_MS, armCancelDrainWatchdog } from './cancel-drain-watchdog'

const TURN_IDLE_TIMEOUT_MS = 25_000
const MAX_PENDING_CHUNKS = 256

export async function* streamSandboxedTurnViaSupervisor(
  input: RunSandboxedTurnInput
): AsyncGenerator<AgentTurnChunk> {
  let lastError: Error | undefined

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      yield* streamSandboxedTurnViaSupervisorOnce(input)
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const code = error instanceof SandboxError ? error.code : ''
      const retryable =
        code === 'sandbox.supervisor.crashed' ||
        code === 'sandbox.supervisor.disconnected' ||
        code === 'sandbox.supervisor.cleanup_failed'
      if (!retryable || attempt === 1) throw lastError
      console.warn('[sandbox] supervisor turn failed, retrying once:', lastError.message)
      await getSandboxSupervisorManager().ensureReady()
    }
  }

  if (lastError) throw lastError
}

async function* streamSandboxedTurnViaSupervisorOnce(
  input: RunSandboxedTurnInput
): AsyncGenerator<AgentTurnChunk> {
  if (input.signal?.aborted) {
    throw new SandboxError('sandbox turn cancelled', 'sandbox.turn.cancelled', 'supervisor')
  }
  const manager = getSandboxSupervisorManager()
  await manager.ensureReady()

  const sessionId = randomUUID()
  sandboxTurnDebug('supervisor-client: start-turn', {
    sessionId,
    role: input.role,
    coreCode: input.coreCode
  })
  const pending: AgentTurnChunk[] = []
  // A provider-level `completed` chunk only means the worker finished producing
  // output. Do not expose it to the executor until the supervisor confirms that
  // worker cleanup (stderr drain + process reap) also completed successfully.
  let bufferedCompleted: AgentTurnChunk | undefined
  let finished = false
  let failure: Error | undefined
  const waiters: Array<() => void> = []
  let cancelEscalation: { clear: () => void } | undefined

  const notify = (): void => {
    for (const wake of waiters.splice(0)) wake()
  }

  const onCrash = (error: Error): void => {
    if (finished) return
    failure = new SandboxError(error.message, 'sandbox.supervisor.cleanup_failed', 'supervisor')
    finished = true
    notify()
  }

  const onEvent = (event: SupervisorEvent): void => {
    if ('sessionId' in event && event.sessionId !== sessionId) return

    switch (event.type) {
      case 'session-state':
        sandboxTurnDebug('supervisor-client: session-state', {
          sessionId,
          state: event.state
        })
        notify()
        break
      case 'chunk':
        if (event.chunk.type === 'completed') {
          if (pending.length === 0 && !bufferedCompleted) {
            sandboxTurnDebug('supervisor-client: first chunk', {
              sessionId,
              type: event.chunk.type
            })
          }
          bufferedCompleted = event.chunk
          notify()
          break
        }
        if (pending.length >= MAX_PENDING_CHUNKS) {
          failure = new SandboxError('supervisor chunk queue overflow', 'sandbox.queue.overflow')
          finished = true
          notify()
          break
        }
        if (pending.length === 0) {
          sandboxTurnDebug('supervisor-client: first chunk', {
            sessionId,
            type: event.chunk.type
          })
        }
        pending.push(event.chunk)
        if (event.chunk.type === 'error') {
          failure = sandboxErrorFromErrorChunk(event.chunk)
          finished = true
        }
        notify()
        break
      case 'exit':
        sandboxTurnDebug('supervisor-client: exit', {
          sessionId,
          code: event.code,
          status: event.status,
          errorCode: event.errorCode,
          stderrPreview: event.stderr?.slice(0, 300)
        })
        if (event.status === 'cancelled') {
          failure = new SandboxError('sandbox turn cancelled', 'sandbox.turn.cancelled')
        } else if (event.status === 'timed_out') {
          failure = new SandboxError('sandbox turn timed out', 'sandbox.turn.timed_out')
        } else if (event.code !== 0 && event.code !== null) {
          failure = new SandboxError(
            event.stderr?.trim() || `sandbox worker exited ${event.code}`,
            event.errorCode ?? 'sandbox.worker.exit'
          )
        }
        if (!failure && bufferedCompleted) {
          pending.push(bufferedCompleted)
        }
        bufferedCompleted = undefined
        finished = true
        notify()
        break
      case 'error':
        failure = new SandboxError(event.message, event.code ?? 'sandbox.supervisor.error')
        finished = true
        notify()
        break
      default:
        break
    }
  }

  manager.on('event', onEvent)
  manager.on('crash', onCrash)

  const abort = (): void => {
    try {
      manager.send({ type: 'cancel', sessionId })
    } catch {
      // ignore
    }
    if (cancelEscalation) return
    cancelEscalation = armCancelDrainWatchdog({
      timeoutMs: CLIENT_CANCEL_DRAIN_TIMEOUT_MS,
      isStale: () => finished,
      onTimeout: () => {
        void manager.recycle(`cancelled sandbox session ${sessionId} did not drain`).then(
          () => {
            if (finished) return
            failure = new SandboxError(
              'sandbox supervisor was recycled after cancellation did not drain',
              'sandbox.supervisor.cleanup_failed',
              'supervisor'
            )
            finished = true
            notify()
          },
          (error) => {
            if (finished) return
            failure =
              error instanceof Error
                ? error
                : new SandboxError(String(error), 'sandbox.supervisor.cleanup_failed', 'supervisor')
            finished = true
            notify()
          }
        )
      }
    })
  }
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) abort()

  try {
    manager.send({
      type: 'start-turn',
      sessionId,
      input: {
        ...input,
        signal: undefined
      }
    })
  } catch (error) {
    manager.off('event', onEvent)
    manager.off('crash', onCrash)
    const message = error instanceof Error ? error.message : String(error)
    throw new SandboxError(message, 'sandbox.supervisor.disconnected')
  }

  try {
    while (!finished || pending.length > 0) {
      if (pending.length > 0) {
        yield pending.shift()!
        continue
      }
      if (finished) break
      await new Promise<void>((resolve) => {
        const waitState: { timeout?: ReturnType<typeof setTimeout> } = {}
        const wake = (): void => {
          if (waitState.timeout) clearTimeout(waitState.timeout)
          resolve()
        }
        waiters.push(wake)
        waitState.timeout = setTimeout(() => {
          const index = waiters.indexOf(wake)
          if (index >= 0) waiters.splice(index, 1)
          resolve()
        }, TURN_IDLE_TIMEOUT_MS)
      })
    }
    if (failure) throw failure
  } finally {
    cancelEscalation?.clear()
    manager.off('event', onEvent)
    manager.off('crash', onCrash)
    input.signal?.removeEventListener('abort', abort)
  }
}
