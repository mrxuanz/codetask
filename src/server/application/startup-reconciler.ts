import type { JobAggregate } from '@shared/contracts/control-plane'

export type InterruptionReason = 'process_crash' | 'stale_lease' | 'app_shutdown'

export type ReconcileDecision =
  | { readonly kind: 'settle_paused'; readonly failureReason: 'interrupted_checkpoint' | null }
  | { readonly kind: 'settle_interrupted_failure'; readonly reason: InterruptionReason }
  | { readonly kind: 'settle_runtime_lost'; readonly reason: 'child_closed' | 'owner_missing' }
  | { readonly kind: 'kill_orphan_keep_job' }
  | { readonly kind: 'quarantine'; readonly violationCode: string }
  | { readonly kind: 'no_change' }

export interface ReconcileInput {
  readonly job: JobAggregate
  readonly runIsStale: boolean
  readonly interruptionReason: InterruptionReason
  readonly hasRunningAttempt: boolean
  readonly hasLegacyActiveRuntime: boolean
  readonly runBelongsToCurrentBoot: boolean
  readonly hasActiveSlot: boolean
  readonly hasRegisteredRuntimeInstance: boolean
  readonly hasSupervisedLifecycleOperation: boolean
  readonly runtimeWasClosed: boolean
}

export function decideStartupReconcile(input: ReconcileInput): ReconcileDecision {
  if (input.job.state === 'pausing' && input.job.controlIntent === 'pause') {
    return {
      kind: 'settle_paused',
      failureReason: input.hasRunningAttempt ? 'interrupted_checkpoint' : null
    }
  }

  if (input.job.state === 'paused' && input.hasLegacyActiveRuntime) {
    return { kind: 'kill_orphan_keep_job' }
  }

  if (
    isRunning(input.job.state) &&
    input.job.controlIntent === 'none' &&
    input.runIsStale
  ) {
    return { kind: 'settle_interrupted_failure', reason: input.interruptionReason }
  }

  if (
    isRunning(input.job.state) &&
    input.runBelongsToCurrentBoot &&
    (!input.hasActiveSlot ||
      (!input.hasRegisteredRuntimeInstance && !input.hasSupervisedLifecycleOperation))
  ) {
    return {
      kind: 'settle_runtime_lost',
      reason: input.runtimeWasClosed ? 'child_closed' : 'owner_missing'
    }
  }

  if (isQueued(input.job.state) && input.job.activeRunId !== null) {
    return { kind: 'quarantine', violationCode: 'job.queued_has_active_run' }
  }

  if (isTerminal(input.job.state) && input.hasLegacyActiveRuntime) {
    return { kind: 'kill_orphan_keep_job' }
  }

  return { kind: 'no_change' }
}

function isRunning(state: string): boolean {
  return state === 'planning_running' || state === 'execution_running'
}

function isQueued(state: string): boolean {
  return state === 'planning_queued' || state === 'execution_queued'
}

function isTerminal(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}
