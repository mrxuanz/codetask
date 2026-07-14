import type { RuntimeExit, RuntimeHandle } from './runtime-supervisor'

export interface StartRuntimeInput {
  readonly jobId: string
  readonly runId: string
  readonly kind: 'planning' | 'execution'
  readonly fenceToken: string
  readonly executionGeneration: number
  readonly abortSignal: AbortSignal
}

export interface RuntimeProvider {
  start(input: StartRuntimeInput): Promise<RuntimeHandle>
}

export interface WorkIdentity {
  readonly jobId: string
  readonly runId: string
  readonly fenceToken: string
  readonly executionGeneration: number
  readonly expectedRevision: number
}

export type RuntimeExitSettler = (
  identity: WorkIdentity,
  runtimeInstanceId: string,
  exit: RuntimeExit
) => Promise<void>
