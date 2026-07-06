import { createHash } from 'crypto'
import type { SavedJobPlan } from '../../planner/plan-types'
import type { TaskProgressItemDto, TaskProgressSliceDto } from '../types'
import { hydrateTaskEvidenceSync } from './store'

function sliceTaskIds(plan: SavedJobPlan, sliceId: string): string[] {
  const match = /^m(\d+)-s(\d+)$/.exec(sliceId)
  if (!match) return []
  const m = Number(match[1])
  const s = Number(match[2])
  return plan.tasks
    .filter((task) => task.milestoneIndex === m && task.sliceIndex === s)
    .map((task) => task.id)
    .sort()
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

function resolvedEvidence(
  dataDir: string,
  item: TaskProgressItemDto | undefined
): TaskProgressItemDto['evidence'] {
  if (!item?.evidence && !item?.evidenceArtifactId) return null
  return hydrateTaskEvidenceSync(dataDir, item.evidence ?? null, item.evidenceArtifactId)
}

export function computeSliceEvidenceBundleHash(
  plan: SavedJobPlan,
  sliceId: string,
  taskItems: TaskProgressItemDto[],
  dataDir?: string
): string {
  const payload = sliceTaskIds(plan, sliceId).map((taskId) => {
    const item = taskItems.find((row) => row.id === taskId)
    const evidence = dataDir ? resolvedEvidence(dataDir, item) : (item?.evidence ?? null)
    return {
      id: taskId,
      status: item?.status ?? null,
      evidence
    }
  })
  return hashPayload(payload)
}

export function computeMilestoneEvidenceBundleHash(
  plan: SavedJobPlan,
  milestoneId: string,
  taskItems: TaskProgressItemDto[],
  progressSlices?: TaskProgressSliceDto[],
  dataDir?: string
): string {
  const match = /^m(\d+)$/.exec(milestoneId)
  if (!match) return hashPayload({ milestoneId, taskItems, progressSlices })
  const milestoneIndex = Number(match[1])
  const taskIds = plan.tasks
    .filter((task) => task.milestoneIndex === milestoneIndex)
    .map((task) => task.id)
    .sort()
  const payload = {
    tasks: taskIds.map((taskId) => {
      const item = taskItems.find((row) => row.id === taskId)
      const evidence = dataDir ? resolvedEvidence(dataDir, item) : (item?.evidence ?? null)
      return {
        id: taskId,
        status: item?.status ?? null,
        evidence
      }
    }),
    sliceVerdicts: (progressSlices ?? [])
      .filter((slice) => slice.id.startsWith(`${milestoneId}-`))
      .map((slice) => ({ id: slice.id, verdict: slice.verdict ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
  return hashPayload(payload)
}
