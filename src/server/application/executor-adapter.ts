import type { ControlPlaneRuntime } from './control-plane-runtime'
import type {
  ExecutionRunContext,
  ExecutionStepResult,
  ExecutorDependencies,
  NextWorkDecision
} from './executor-loop'
import type { WorkerCommandEnvelope } from '@shared/contracts/control-plane'

type EmptyWorkerCommand = WorkerCommandEnvelope<Record<string, never>>

/**
 * Binds the generic V3 loop to the authoritative control-plane repositories.
 * Job macro-state changes remain command-service operations; the adapter only
 * selects work and creates task-attempt records immediately before checkpointing.
 */
export function createExecutorDependencies(
  runtime: ControlPlaneRuntime,
  _context: ExecutionRunContext
): ExecutorDependencies {
  return {
    queryNextWork: async (runContext) => queryNextWork(runtime, runContext),
    executeOneDecision: async (decision, runContext) =>
      executeOneDecision(runtime, decision, runContext),
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
  runtime: ControlPlaneRuntime,
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

  if (tasks.every((task) => task.state === 'completed' || task.state === 'skipped')) {
    return { kind: 'complete', revision: job.stateRevision }
  }

  return { kind: 'stale_run' }
}

async function executeOneDecision(
  runtime: ControlPlaneRuntime,
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
  if (task === null || task.state !== 'queued') return { kind: 'stale_run' }

  const started = runtime.taskRepository.updateTaskState(
    context.jobId,
    context.executionGeneration,
    taskId,
    'queued',
    'running'
  )
  if (!started) return { kind: 'stale_run' }

  const attemptId = runtime.taskRepository.createAttempt(
    context.jobId,
    context.executionGeneration,
    taskId,
    context.runId
  )
  const checkpoint = await runtime.commandService.checkpointTask({
    jobId: context.jobId,
    runId: context.runId,
    fenceToken: context.fenceToken,
    executionGeneration: context.executionGeneration,
    expectedRevision: context.expectedRevision,
    payload: {
      attemptId,
      result: {
        status: 'completed',
        summary: `Completed task: ${task.title}`,
        changedFiles: [],
        evidence: [`V3 executor completed task ${taskId}.`],
        validation: { ran: false, outcome: 'not-applicable' },
        blockers: [],
        blockerKind: null
      }
    }
  })

  return {
    kind: 'advanced',
    revision: checkpoint.revision,
    workIdentity: decision.key
  }
}
