import type { JobTreeDto } from '@codetask/contracts'
import type { UnifiedMilestoneNode, UnifiedTaskNode } from '@codetask/contracts/plan-tree'
import type { DesignExecutionTreeSnapshot } from '@renderer/api/design'

function isDesignExecutionTree(value: unknown): value is DesignExecutionTreeSnapshot {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'treeId' in value &&
    'planningSessionId' in value &&
    Array.isArray((value as { milestones?: unknown }).milestones)
  )
}

function isExecutionJobTree(value: unknown): value is JobTreeDto {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'jobId' in value &&
    'generation' in value &&
    Array.isArray((value as { milestones?: unknown }).milestones)
  )
}

function mapDesignExecutionTree(tree: DesignExecutionTreeSnapshot): UnifiedMilestoneNode[] {
  return tree.milestones.map((milestone, milestoneIndex) => ({
    id: milestone.id,
    title: milestone.title,
    description: milestone.description,
    successCriteria: milestone.successCriteria,
    order: milestoneIndex + 1,
    status: milestone.confirmed ? 'planned' : 'pending',
    slices: milestone.slices.map((slice, sliceIndex) => ({
      id: slice.id,
      title: slice.title,
      description: slice.description,
      successCriteria: slice.successCriteria,
      order: sliceIndex + 1,
      status: slice.confirmed ? 'planned' : 'pending',
      tasks: slice.tasks.map(
        (task, taskIndex): UnifiedTaskNode => ({
          id: task.id,
          title: task.title,
          description: task.description,
          taskKind: task.taskKind,
          abilityCode: task.abilityCode,
          contextMarkdown: task.contextMarkdown,
          successCriteria: task.successCriteria,
          order: taskIndex + 1,
          planStatus: task.confirmed ? 'planned' : 'pending',
          status: task.confirmed ? 'planned' : 'pending',
          executionStatus: null,
          providerCode: task.providerCode,
          referenceIds: task.referenceIds,
          referenceReason: task.referenceReason
        })
      )
    }))
  }))
}

function mapWorkStatus(state: string): { status: string; executionStatus: string } {
  switch (state) {
    case 'leased':
    case 'running':
    case 'reported':
      return { status: 'in_progress', executionStatus: 'running' }
    case 'succeeded':
      return { status: 'completed', executionStatus: 'completed' }
    case 'failed':
      return { status: 'failed', executionStatus: 'failed' }
    case 'blocked':
      return { status: 'blocked', executionStatus: 'blocked' }
    case 'cancelled':
    case 'skipped':
      return { status: 'skipped', executionStatus: 'skipped' }
    default:
      return { status: 'pending', executionStatus: 'queued' }
  }
}

function mapExecutionJobTree(tree: JobTreeDto): UnifiedMilestoneNode[] {
  return tree.milestones.map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    description: milestone.description,
    successCriteria: milestone.successCriteria,
    order: milestone.sortOrder + 1,
    status: milestone.state,
    verificationStatus: milestone.state,
    slices: milestone.slices.map((slice) => ({
      id: slice.id,
      title: slice.title,
      description: slice.description,
      successCriteria: slice.successCriteria,
      order: slice.sortOrder + 1,
      status: slice.state,
      runtimeStatus: slice.state,
      verificationStatus: slice.verificationState,
      tasks: slice.workItems.map((work): UnifiedTaskNode => {
        const execution = mapWorkStatus(work.state)
        return {
          id: work.id,
          title: work.title,
          description: work.description,
          taskKind: work.taskKind,
          abilityCode: work.abilityCode,
          contextMarkdown: work.contextMarkdown,
          successCriteria: work.successCriteria,
          order: work.sortOrder + 1,
          planStatus: 'queued',
          status: execution.status,
          executionStatus: execution.executionStatus,
          providerCode: work.providerCode,
          referenceIds: work.referenceIds,
          referenceReason: work.referenceReason
        }
      })
    }))
  }))
}

/** Maps modern Design/Execution tree contracts without regenerating synthetic node ids. */
export function mapModernProgressTree(value: unknown): UnifiedMilestoneNode[] | null {
  if (isDesignExecutionTree(value)) return mapDesignExecutionTree(value)
  if (isExecutionJobTree(value)) return mapExecutionJobTree(value)
  return null
}
