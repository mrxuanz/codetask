import type { JobAggregate } from '../../../src/shared/contracts/control-plane/schemas'
import type {
  JobState,
  ControlIntent,
  ResumeTarget
} from '../../../src/shared/contracts/control-plane/primitives'

type JobAggregateOverrides = {
  readonly state?: JobState
  readonly controlIntent?: ControlIntent
  readonly resumeTarget?: ResumeTarget | null
  readonly activeRunId?: string | null
  readonly currentPlanRevision?: number | null
  readonly executionGeneration?: number
  readonly stateRevision?: number
  readonly lastFailureId?: string | null
}

function nullableOrDefault<T>(
  value: T | undefined,
  defaultValue: T
): T {
  return value !== undefined ? value : defaultValue
}

export function buildJobAggregate(
  overrides?: JobAggregateOverrides
): JobAggregate {
  return {
    id: 'job-1',
    threadId: 'thread-1',
    projectId: 'project-1',
    state: overrides?.state ?? 'execution_queued',
    stateRevision: overrides?.stateRevision ?? 1,
    controlIntent: overrides?.controlIntent ?? 'none',
    resumeTarget: nullableOrDefault(overrides?.resumeTarget, null),
    currentPlanRevision: nullableOrDefault(overrides?.currentPlanRevision, 1),
    executionGeneration: overrides?.executionGeneration ?? 1,
    activeRunId: nullableOrDefault(overrides?.activeRunId, null),
    lastFailureId: nullableOrDefault(overrides?.lastFailureId, null)
  }
}
