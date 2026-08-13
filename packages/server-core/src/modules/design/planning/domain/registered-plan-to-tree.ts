import type { ExecutionTreeSnapshot } from '@codetask/contracts'
import { newId } from '../../shared.ts'
import { buildTreeFromOutline } from './planning.ts'
import type { PlannerRegisteredPlan } from '../mcp/types.ts'

/** Legacy planner MCP outline + contexts → Design ExecutionTreeSnapshot (stable UUID node ids). */
export function registeredPlanToExecutionTree(input: {
  planningSessionId: string
  plan: PlannerRegisteredPlan
  contexts: Map<string, { taskTitle: string; content: string }>
  defaultCoreCode: string
}): ExecutionTreeSnapshot {
  const milestoneIds = input.plan.milestones.map(() => newId('ms'))
  const sliceCoordToId = new Map<string, string>()
  const taskCoordToId = new Map<string, string>()

  input.plan.milestones.forEach((milestone, mIdx) => {
    milestone.slices.forEach((slice, sIdx) => {
      sliceCoordToId.set(`m${mIdx + 1}-s${sIdx + 1}`, newId('sl'))
      slice.tasks.forEach((_task, tIdx) => {
        taskCoordToId.set(`m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1}`, newId('tk'))
      })
    })
  })

  const requireId = (ids: Map<string, string>, ref: string): string => {
    const id = ids.get(ref.trim().toLowerCase())
    if (!id) throw new Error(`Planner dependency was not normalized: ${ref}`)
    return id
  }

  const milestones = input.plan.milestones.map((milestone, mIdx) => {
    const milestoneId = milestoneIds[mIdx]!
    return {
      id: milestoneId,
      title: milestone.title?.trim() || `Milestone ${mIdx + 1}`,
      description: milestone.description?.trim() || '',
      successCriteria: milestone.successCriteria?.trim() || 'Milestone complete',
      slices: milestone.slices.map((slice, sIdx) => {
        const sliceCoord = `m${mIdx + 1}-s${sIdx + 1}`
        const sliceId = requireId(sliceCoordToId, sliceCoord)
        return {
          id: sliceId,
          title: slice.title?.trim() || `Slice ${sIdx + 1}`,
          description: slice.description?.trim() || '',
          successCriteria: slice.successCriteria,
          dependsOnSliceIds: (slice.dependsOnSliceRefs ?? []).map((ref) =>
            requireId(sliceCoordToId, ref)
          ),
          tasks: slice.tasks.map((task, tIdx) => {
            const coord = `m${mIdx + 1}-s${sIdx + 1}-t${tIdx + 1}`
            const taskId = requireId(taskCoordToId, coord)
            const context = input.contexts.get(coord)
            const taskSuccess = task.successCriteria?.trim()
            return {
              id: taskId,
              title: task.title?.trim() || context?.taskTitle || coord,
              description: task.description?.trim() || '',
              taskKind: task.taskKind,
              abilityCode: task.abilityCode ?? 'general-implementation',
              coreCode: input.defaultCoreCode,
              contextMarkdown: context?.content ?? '',
              successCriteria: taskSuccess || slice.successCriteria,
              referenceIds: task.referenceIds ?? [],
              referenceReason: task.referenceReason?.trim() ?? '',
              requiredInputs: task.requiredInputs ?? [],
              dependsOnTaskIds: (task.dependsOnTaskRefs ?? []).map((ref) =>
                requireId(taskCoordToId, ref)
              ),
              canRunInParallel: Boolean(task.canRunInParallel)
            }
          })
        }
      })
    }
  })

  return buildTreeFromOutline({
    planningSessionId: input.planningSessionId,
    treeId: newId('tree'),
    revision: 0,
    milestones
  })
}
