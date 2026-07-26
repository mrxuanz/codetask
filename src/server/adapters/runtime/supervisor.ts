/**
 * Runtime Supervisor: process-tree ownership registry, cancel/timeout/hard-kill
 * stubs, and bounded stdout capture (重构.md §10.7–10.8).
 */

import {
  createBoundedOutput,
  type BoundedOutputBuffer
} from '../../core/application/runtime/bounded-output.ts'

export type SupervisedTurnStatus =
  | 'running'
  | 'cancelled'
  | 'timed_out'
  | 'killed'
  | 'exited'

export interface SupervisedTurn {
  readonly turnId: string
  readonly jobId: string
  readonly providerCode: string
  readonly registeredAtMs: number
  status: SupervisedTurnStatus
  pid: number | null
  readonly stdout: BoundedOutputBuffer
  readonly stderr: BoundedOutputBuffer
}

export interface RegisterTurnInput {
  readonly turnId: string
  readonly jobId: string
  readonly providerCode: string
  readonly maxStdoutBytes: number
  readonly pid?: number | null
}

export class RuntimeSupervisor {
  private readonly turns = new Map<string, SupervisedTurn>()

  register(input: RegisterTurnInput): SupervisedTurn {
    if (this.turns.has(input.turnId)) {
      throw new Error(`turn already registered: ${input.turnId}`)
    }
    const turn: SupervisedTurn = {
      turnId: input.turnId,
      jobId: input.jobId,
      providerCode: input.providerCode,
      registeredAtMs: Date.now(),
      status: 'running',
      pid: input.pid ?? null,
      stdout: createBoundedOutput(input.maxStdoutBytes),
      stderr: createBoundedOutput(input.maxStdoutBytes)
    }
    this.turns.set(input.turnId, turn)
    return turn
  }

  get(turnId: string): SupervisedTurn | undefined {
    return this.turns.get(turnId)
  }

  list(): readonly SupervisedTurn[] {
    return [...this.turns.values()]
  }

  appendStdout(turnId: string, chunk: Buffer | string): void {
    const turn = this.require(turnId)
    turn.stdout.append(chunk)
  }

  appendStderr(turnId: string, chunk: Buffer | string): void {
    const turn = this.require(turnId)
    turn.stderr.append(chunk)
  }

  /** Soft cancel stub — marks ownership; OS kill wired in later waves. */
  cancel(turnId: string): SupervisedTurn {
    const turn = this.require(turnId)
    if (turn.status === 'running') turn.status = 'cancelled'
    return turn
  }

  /** Timeout stub. */
  timeout(turnId: string): SupervisedTurn {
    const turn = this.require(turnId)
    if (turn.status === 'running') turn.status = 'timed_out'
    return turn
  }

  /** Hard kill stub — marks killed; native terminate to follow. */
  hardKill(turnId: string): SupervisedTurn {
    const turn = this.require(turnId)
    turn.status = 'killed'
    return turn
  }

  markExited(turnId: string): SupervisedTurn {
    const turn = this.require(turnId)
    if (turn.status === 'running') turn.status = 'exited'
    return turn
  }

  unregister(turnId: string): void {
    this.turns.delete(turnId)
  }

  private require(turnId: string): SupervisedTurn {
    const turn = this.turns.get(turnId)
    if (!turn) throw new Error(`unknown supervised turn: ${turnId}`)
    return turn
  }
}
