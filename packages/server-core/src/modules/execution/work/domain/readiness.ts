import type { JobControlIntent, JobState } from '@codetask/contracts'
import type { ReadyWorkSet, WorkDependencyRecord, WorkItemRecord } from './work-item.ts'
import { isWorkTerminal } from './work-item.ts'
import { buildAdjacency } from './dependency-graph.ts'

export function computeReadyWork(input: {
  jobId: string
  jobState: JobState
  controlIntent: JobControlIntent
  generation: number
  workItems: WorkItemRecord[]
  dependencies: WorkDependencyRecord[]
  succeededWorkIds: Set<string>
}): ReadyWorkSet {
  const { jobId, jobState, controlIntent, generation, workItems, dependencies, succeededWorkIds } =
    input
  const blocked: ReadyWorkSet['blocked'] = []
  const workIds: string[] = []

  if (jobState !== 'running' || controlIntent !== 'none') {
    return { jobId, workIds, blocked }
  }

  const depsByWork = buildAdjacency(dependencies.filter((d) => d.generation === generation))
  const currentWork = workItems.filter((w) => w.generation === generation)

  for (const work of currentWork) {
    if (work.state !== 'pending') continue
    const deps = depsByWork.get(work.id) ?? []
    const missing = deps.filter((depId) => !succeededWorkIds.has(depId))
    if (missing.length > 0) {
      blocked.push({ workId: work.id, blockers: missing })
      continue
    }
    workIds.push(work.id)
  }

  workIds.sort((a, b) => {
    const wa = currentWork.find((w) => w.id === a)!
    const wb = currentWork.find((w) => w.id === b)!
    return wa.sortOrder - wb.sortOrder
  })

  return { jobId, workIds, blocked }
}

export function computeSliceReadyForVerification(input: {
  sliceId: string
  generation: number
  workItems: WorkItemRecord[]
}): boolean {
  const sliceWork = input.workItems.filter(
    (w) => w.generation === input.generation && w.sliceId === input.sliceId
  )
  if (sliceWork.length === 0) return false
  // Terminal (incl. failed/blocked) so Slice Verdict can emit needs-repair / blocked.
  return sliceWork.every((w) => isWorkTerminal(w.state))
}

export function computeMilestoneReadyForVerification(input: {
  milestoneId: string
  generation: number
  sliceIds: string[]
  sliceVerificationStates: Map<string, string>
}): boolean {
  for (const sliceId of input.sliceIds) {
    if (input.sliceVerificationStates.get(sliceId) !== 'progress-ok') return false
  }
  return input.sliceIds.length > 0
}

export function computeJobCompletion(input: {
  milestoneIds: string[]
  milestoneStates: Map<string, string>
}): boolean {
  if (input.milestoneIds.length === 0) return false
  return input.milestoneIds.every((id) => input.milestoneStates.get(id) === 'passed')
}

export function computeDeadlock(input: {
  jobState: JobState
  controlIntent: JobControlIntent
  readyWorkIds: string[]
  pendingWorkCount: number
  blocked: ReadyWorkSet['blocked']
}): string[] | null {
  if (input.jobState !== 'running' || input.controlIntent !== 'none') return null
  if (input.readyWorkIds.length > 0) return null
  if (input.pendingWorkCount === 0) return null
  const blockers = input.blocked.flatMap((b) => b.blockers)
  return blockers.length > 0 ? blockers : ['no-ready-work']
}
