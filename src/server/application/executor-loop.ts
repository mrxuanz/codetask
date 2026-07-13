/**
 * V3 executor loop — production macro-state writes go through Command only.
 *
 * C6: There is no `updateJobRow` / legacy status write path in this file.
 * Pause ack, completion, and no-progress all call `deps.commandService`.
 * Task/verification progress must also be recorded via fenced Command APIs
 * inside `executeOneDecision` implementations (not via legacy repository patches).
 */
export type ExecutionStepResult =
  | { readonly kind: 'advanced'; readonly revision: number; readonly workIdentity: string }
  | { readonly kind: 'waiting'; readonly externalOperationId: string }
  | { readonly kind: 'finished' }
  | { readonly kind: 'stale_run' }
  | { readonly kind: 'failed'; readonly failureId: string }

export interface ExecutionRunContext {
  readonly jobId: string
  readonly runId: string
  readonly fenceToken: string
  readonly executionGeneration: number
  expectedRevision: number
  workIdentity: string
}

export interface ExecutorDependencies {
  readonly queryNextWork: (context: ExecutionRunContext) => Promise<NextWorkDecision>
  readonly executeOneDecision: (
    decision: NextWorkDecision,
    context: ExecutionRunContext
  ) => Promise<ExecutionStepResult>
  readonly commandService: {
    acknowledgePause(input: unknown): Promise<void>
    completeExecution(input: unknown): Promise<void>
    reportNoProgress(input: unknown): Promise<void>
  }
  readonly runtimeSupervisor: {
    waitForExternalOperation(operationId: string, signal: AbortSignal): Promise<void>
  }
}

export type NextWorkDecision =
  | { readonly kind: 'stale_run' }
  | { readonly kind: 'pause_requested'; readonly revision: number }
  | { readonly kind: 'complete'; readonly revision: number }
  | { readonly kind: 'work'; readonly key: string }

export async function executeRun(
  context: ExecutionRunContext,
  deps: ExecutorDependencies,
  signal: AbortSignal
): Promise<void> {
  for (;;) {
    if (signal.aborted) return

    const decision = await deps.queryNextWork(context)
    if (decision.kind === 'stale_run') return

    if (decision.kind === 'pause_requested') {
      await deps.commandService.acknowledgePause({
        jobId: context.jobId,
        runId: context.runId,
        fenceToken: context.fenceToken,
        executionGeneration: context.executionGeneration,
        expectedRevision: decision.revision,
        payload: {}
      })
      return
    }

    if (decision.kind === 'complete') {
      await deps.commandService.completeExecution({
        jobId: context.jobId,
        runId: context.runId,
        fenceToken: context.fenceToken,
        executionGeneration: context.executionGeneration,
        expectedRevision: decision.revision,
        payload: {}
      })
      return
    }

    const step = await deps.executeOneDecision(decision, context)
    if (step.kind === 'stale_run' || step.kind === 'finished' || step.kind === 'failed') return

    if (step.kind === 'waiting') {
      await deps.runtimeSupervisor.waitForExternalOperation(step.externalOperationId, signal)
      continue
    }

    const progressed =
      step.revision > context.expectedRevision || step.workIdentity !== context.workIdentity

    if (!progressed) {
      await deps.commandService.reportNoProgress({
        jobId: context.jobId,
        runId: context.runId,
        fenceToken: context.fenceToken,
        executionGeneration: context.executionGeneration,
        decisionKey: decision.key,
        observedRevision: step.revision,
        workIdentity: step.workIdentity
      })
      return
    }

    context.expectedRevision = step.revision
    context.workIdentity = step.workIdentity
  }
}
