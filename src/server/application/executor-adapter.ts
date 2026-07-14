import type {
  ExecutionRunContext,
  ExecutionStepResult,
  ExecutorDependencies,
  NextWorkDecision
} from './executor-loop'
import type { TaskExecutionProvider } from './ports/task-execution-provider'
import type { Clock } from './ports/clock'
import type { IdGenerator } from './ports/id-generator'
import type { JobCommandService, WorkerCommandEnvelope } from '@shared/contracts/control-plane'
import type { JobRepository } from './ports/job-repository'
import type { TaskRepository } from './ports/task-repository'
import type { ControlPlaneUnitOfWork } from './ports/unit-of-work'
import type { RuntimeSupervisor } from './runtime-supervisor'
import {
  TaskResultValidationError,
  validateTaskResult
} from '../domain/tasks/validate-task-result'

type EmptyWorkerCommand = WorkerCommandEnvelope<Record<string, never>>

/** Narrow ports the executor loop needs — avoids casting a full ControlPlaneRuntime in tests. */
export type ExecutorRuntimePorts = {
  readonly jobRepository: JobRepository
  readonly taskRepository: TaskRepository
  readonly unitOfWork: ControlPlaneUnitOfWork
  readonly commandService: JobCommandService
  readonly runtimeSupervisor: RuntimeSupervisor
}

export type ExecutorAdapterConfig = {
  readonly runtime: ExecutorRuntimePorts
  readonly taskExecutionProvider: TaskExecutionProvider
  readonly clock?: Clock
  readonly idGenerator?: IdGenerator
}

const defaultClock: Clock = { nowMs: () => Date.now() }
const defaultIds: IdGenerator = { generate: () => crypto.randomUUID() }

/**
 * Binds the generic V3 loop to the authoritative control-plane repositories.
 * Task results come only from the injected TaskExecutionProvider — never synthesized here.
 */
export function createExecutorDependencies(
  config: ExecutorAdapterConfig,
  context: ExecutionRunContext
): ExecutorDependencies {
  const { runtime, taskExecutionProvider } = config
  const clock = config.clock ?? defaultClock
  const idGenerator = config.idGenerator ?? defaultIds
  return {
    queryNextWork: async (runContext) => queryNextWork(runtime, runContext),
    executeOneDecision: async (decision, runContext) =>
      executeOneDecision(runtime, taskExecutionProvider, clock, idGenerator, decision, runContext),
    commandService: {
      acknowledgePause: async (input) =>
        runtime.commandService.acknowledgePause(input as EmptyWorkerCommand),
      completeExecution: async (input) =>
        runtime.commandService.completeExecution(input as EmptyWorkerCommand),
      reportNoProgress: async (input) => {
        await runtime.commandService.reportNoProgress(
          input as WorkerCommandEnvelope<{
            decisionKey: string
            observedRevision: number
            workIdentity: string
          }>
        )
      }
    },
    runtimeSupervisor: runtime.runtimeSupervisor
  }
}

async function queryNextWork(
  runtime: ExecutorRuntimePorts,
  context: ExecutionRunContext
): Promise<NextWorkDecision> {
  const job = runtime.jobRepository.getWorkerAggregate({
    jobId: context.jobId,
    runId: context.runId,
    fenceToken: context.fenceToken,
    executionGeneration: context.executionGeneration
  })
  if (job === null) return { kind: 'stale_run' }

  if (job.controlIntent === 'pause') {
    return { kind: 'pause_requested', revision: job.stateRevision }
  }

  const tasks = runtime.taskRepository.listTasksForGeneration(
    context.jobId,
    context.executionGeneration
  )
  const nextQueued = tasks.find((task) => task.state === 'queued')
  if (nextQueued) return { kind: 'work', key: `task:${nextQueued.taskId}` }

  const nextRunning = tasks.find((task) => task.state === 'running')
  if (nextRunning) return { kind: 'work', key: `task:${nextRunning.taskId}` }

  if (tasks.every((task) => task.state === 'completed' || task.state === 'skipped')) {
    return { kind: 'complete', revision: job.stateRevision }
  }

  return { kind: 'stale_run' }
}

async function executeOneDecision(
  runtime: ExecutorRuntimePorts,
  taskExecutionProvider: TaskExecutionProvider,
  clock: Clock,
  idGenerator: IdGenerator,
  decision: NextWorkDecision,
  context: ExecutionRunContext
): Promise<ExecutionStepResult> {
  if (decision.kind !== 'work' || !decision.key.startsWith('task:')) {
    return { kind: 'stale_run' }
  }

  const taskId = decision.key.slice('task:'.length)
  const task = runtime.taskRepository.getCurrentTask(
    context.jobId,
    context.executionGeneration,
    taskId
  )
  if (task === null || (task.state !== 'queued' && task.state !== 'running')) {
    return { kind: 'stale_run' }
  }

  let attemptId: string
  if (task.state === 'queued') {
    const nowMs = clock.nowMs()
    const started = runtime.taskRepository.updateTaskState(
      context.jobId,
      context.executionGeneration,
      taskId,
      'queued',
      'running',
      nowMs
    )
    if (!started) return { kind: 'stale_run' }

    attemptId = runtime.unitOfWork.transaction((tx) => {
      const id = idGenerator.generate()
      tx.tasks.createAttempt({
        id,
        jobId: context.jobId,
        generation: context.executionGeneration,
        taskId,
        runId: context.runId,
        state: 'running',
        startedAtMs: nowMs
      })
      return id
    })
  } else {
    const attempts = runtime.taskRepository.getTaskAttempts(
      context.jobId,
      context.executionGeneration,
      taskId
    )
    const running = attempts.find(
      (attempt) =>
        attempt.runId === context.runId &&
        attempt.state === 'running' &&
        attempt.resultHash === null
    )
    if (running === undefined) {
      return { kind: 'stale_run' }
    }
    attemptId = running.id
  }

  const providerOutcome = await taskExecutionProvider.executeTask({
    jobId: context.jobId,
    runId: context.runId,
    fenceToken: context.fenceToken,
    executionGeneration: context.executionGeneration,
    taskId,
    attemptId,
    title: task.title,
    abortSignal: context.abortSignal
  })

  if (providerOutcome.kind === 'waiting') {
    return {
      kind: 'waiting',
      externalOperationId: providerOutcome.externalOperationId
    }
  }

  let validated
  try {
    validated = validateTaskResult(providerOutcome.raw)
  } catch (error: unknown) {
    if (error instanceof TaskResultValidationError) {
      await runtime.commandService.reportNoProgress({
        jobId: context.jobId,
        runId: context.runId,
        fenceToken: context.fenceToken,
        executionGeneration: context.executionGeneration,
        expectedRevision: context.expectedRevision,
        payload: {
          decisionKey: decision.key,
          observedRevision: context.expectedRevision,
          workIdentity: decision.key
        }
      })
      return { kind: 'stale_run' }
    }
    throw error
  }

  const checkpoint = await runtime.commandService.checkpointTask({
    jobId: context.jobId,
    runId: context.runId,
    fenceToken: context.fenceToken,
    executionGeneration: context.executionGeneration,
    expectedRevision: context.expectedRevision,
    payload: {
      attemptId,
      result: validated.result
    }
  })

  return {
    kind: 'advanced',
    revision: checkpoint.revision,
    workIdentity: decision.key
  }
}
