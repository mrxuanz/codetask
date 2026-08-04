export type CoordinatorDecision =
  | { kind: 'settle-control' }
  | { kind: 'dispatch-work'; workId: string }
  | { kind: 'verify-slice'; sliceId: string }
  | { kind: 'verify-milestone'; milestoneId: string }
  | { kind: 'complete-job' }
  | { kind: 'fail-deadlock'; blockers: string[] }
  | { kind: 'wait' }

export {
  computeReadyWork,
  computeSliceReadyForVerification,
  computeMilestoneReadyForVerification,
  computeJobCompletion,
  computeDeadlock
} from '../domain/readiness.ts'

export { allowedJobActions } from '../../job/domain/job-actions.ts'

import type { JobControlIntent, JobState } from '@codetask/contracts'
import type { WorkItemRecord } from '../domain/work-item.ts'
import type { WorkDependencyRecord } from '../domain/work-item.ts'
import {
  computeDeadlock,
  computeJobCompletion,
  computeMilestoneReadyForVerification,
  computeReadyWork,
  computeSliceReadyForVerification
} from '../domain/readiness.ts'
import { VerificationRepository } from '../../verification/infrastructure/verification-repository.ts'

export function decideNextStep(input: {
  jobId: string
  jobState: JobState
  controlIntent: JobControlIntent
  generation: number
  workItems: WorkItemRecord[]
  dependencies: WorkDependencyRecord[]
  succeededWorkIds: Set<string>
  verification: VerificationRepository
}): CoordinatorDecision {
  const { jobId, jobState, controlIntent, generation, workItems, dependencies, succeededWorkIds } =
    input

  if (jobState === 'pausing' && controlIntent === 'pause') {
    return { kind: 'settle-control' }
  }
  if (jobState === 'cancelling') {
    return { kind: 'settle-control' }
  }
  if (jobState !== 'running' || controlIntent !== 'none') {
    return { kind: 'wait' }
  }

  const ready = computeReadyWork({
    jobId,
    jobState,
    controlIntent,
    generation,
    workItems,
    dependencies,
    succeededWorkIds
  })

  if (ready.workIds.length > 0) {
    return { kind: 'dispatch-work', workId: ready.workIds[0]! }
  }

  const slices = [
    ...new Set(workItems.filter((w) => w.generation === generation).map((w) => w.sliceId))
  ]
  for (const sliceId of slices) {
    const verificationState = input.verification.getSliceVerificationState(
      jobId,
      generation,
      sliceId
    )
    if (verificationState === 'blocked') {
      return { kind: 'fail-deadlock', blockers: [`slice-blocked:${sliceId}`] }
    }
    if (verificationState === 'progress-ok') continue
    if (!computeSliceReadyForVerification({ sliceId, generation, workItems })) continue
    // pending / needs-repair / inconclusive: re-verify when work set is terminal (bundle hash guards loops)
    if (
      verificationState === 'pending' ||
      verificationState === 'needs-repair' ||
      verificationState === 'inconclusive'
    ) {
      return { kind: 'verify-slice', sliceId }
    }
  }

  const milestoneIds = input.verification.listMilestoneIds(jobId, generation)
  for (const milestoneId of milestoneIds) {
    const milestoneState = input.verification.getMilestoneState(jobId, generation, milestoneId)
    if (milestoneState === 'blocked') {
      return { kind: 'fail-deadlock', blockers: [`milestone-blocked:${milestoneId}`] }
    }
    if (milestoneState === 'passed') continue
    const sliceIds = input.verification.listSliceIds(jobId, generation, milestoneId)
    const sliceStates = new Map(
      sliceIds.map((id) => [
        id,
        input.verification.getSliceVerificationState(jobId, generation, id)
      ])
    )
    if (
      computeMilestoneReadyForVerification({
        milestoneId,
        generation,
        sliceIds,
        sliceVerificationStates: sliceStates
      }) &&
      (milestoneState === 'pending' ||
        milestoneState === 'needs-repair' ||
        milestoneState === 'inconclusive')
    ) {
      return { kind: 'verify-milestone', milestoneId }
    }
  }

  const milestoneStates = new Map(
    milestoneIds.map((id) => [id, input.verification.getMilestoneState(jobId, generation, id)])
  )
  if (
    computeJobCompletion({
      milestoneIds,
      milestoneStates
    })
  ) {
    return { kind: 'complete-job' }
  }

  const pendingCount = workItems.filter(
    (w) => w.generation === generation && w.state === 'pending'
  ).length
  const deadlock = computeDeadlock({
    jobState,
    controlIntent,
    readyWorkIds: ready.workIds,
    pendingWorkCount: pendingCount,
    blocked: ready.blocked
  })
  if (deadlock) {
    return { kind: 'fail-deadlock', blockers: deadlock }
  }

  return { kind: 'wait' }
}
