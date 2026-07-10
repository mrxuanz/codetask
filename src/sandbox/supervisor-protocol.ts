import type { AgentTurnChunk } from '../server/agent-runtime/types'
import type { RunSandboxedTurnInput } from '../server/sandbox/orchestrator-local'
import type { SandboxSessionState } from '../server/sandbox/session-state'

export type SupervisorCommand =
  | { type: 'ping' }
  | { type: 'shutdown' }
  | { type: 'start-turn'; sessionId: string; input: RunSandboxedTurnInput }
  | { type: 'cancel'; sessionId: string }
  | { type: 'cancel-job-turns'; jobId: string }
  | { type: 'close-job-cursor'; jobId: string }

export type SupervisorEvent =
  | { type: 'ready' }
  | { type: 'pong' }
  | { type: 'debug'; text: string }
  | { type: 'chunk'; sessionId: string; chunk: AgentTurnChunk }
  | { type: 'session-state'; sessionId: string; state: SandboxSessionState }
  | { type: 'stderr'; sessionId: string; text: string }
  | {
      type: 'exit'
      sessionId: string
      code: number | null
      status: 'exited' | 'cancelled' | 'timed_out' | 'failed'
      stderr?: string
      /** Preserved provider/turn error code when the worker failed with a typed error. */
      errorCode?: string
    }
  | { type: 'error'; sessionId?: string; message: string; code?: string }

export function isSupervisorCommand(value: unknown): value is SupervisorCommand {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  )
}

export function isSupervisorEvent(value: unknown): value is SupervisorEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  )
}
