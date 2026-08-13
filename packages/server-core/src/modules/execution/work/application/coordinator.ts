export type CoordinatorDecision =
  | { kind: 'settle-control' }
  | { kind: 'dispatch-work'; workIds: string[] }
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
import type { SliceDependencyRecord, WorkDependencyRecord } from '../domain/work-item.ts'
import {
  computeDeadlock,
  computeJobCompletion,
  computeMilestoneReadyForVerification,
  computeReadyWork,
  computeSliceReadyForVerification
} from '../domain/readiness.ts'

/** Each work item may own a CLI process/SDK session; never fan out without a hard cap. */
export const MAX_PARALLEL_WORK_ITEMS = 4
import { VerificationRepository } from '../../verification/infrastructure/verification-repository.ts'

export function decideNextStep(input: {
  jobId: string
  jobState: JobState
  controlIntent: JobControlIntent
  generation: number
  workItems: WorkItemRecord[]
  dependencies: WorkDependencyRecord[]
  sliceDependencies: SliceDependencyRecord[]
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

  const byId = new Map(workItems.map((item) => [item.id, item]))
  const sliceDeps = new Map<string, string[]>()
  for (const dependency of input.sliceDependencies) {
    const current = sliceDeps.get(dependency.fromSliceId) ?? []
    current.push(dependency.dependsOnSliceId)
    sliceDeps.set(dependency.fromSliceId, current)
  }
  const dispatchableWorkIds = ready.workIds.filter((workId) => {
    const sliceId = byId.get(workId)?.sliceId
    if (!sliceId) return false
    return (sliceDeps.get(sliceId) ?? []).every(
      (dependsOnSliceId) =>
        input.verification.getSliceVerificationState(jobId, generation, dependsOnSliceId) ===
        'progress-ok'
    )
  })

  if (dispatchableWorkIds.length > 0) {
    const parallelWorkIds = dispatchableWorkIds.filter(
      (workId) => byId.get(workId)?.canRunInParallel
    )
    return {
      kind: 'dispatch-work',
      workIds:
        parallelWorkIds.length > 1
          ? parallelWorkIds.slice(0, MAX_PARALLEL_WORK_ITEMS)
          : [dispatchableWorkIds[0]!]
    }
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
    readyWorkIds: dispatchableWorkIds,
    pendingWorkCount: pendingCount,
    blocked: ready.blocked
  })
  if (deadlock) {
    return { kind: 'fail-deadlock', blockers: deadlock }
  }

  return { kind: 'wait' }
}
