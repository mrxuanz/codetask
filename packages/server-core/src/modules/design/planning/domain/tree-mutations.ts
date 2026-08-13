import type { ExecutionTreeSnapshot, PatchTreeNodeBody } from '@codetask/contracts'

/** Apply an immutable node patch, returning null when the node id is absent. */
export function patchExecutionTreeNode(
  tree: ExecutionTreeSnapshot,
  nodeId: string,
  patch: PatchTreeNodeBody,
  revision: number
): ExecutionTreeSnapshot | null {
  let found = false
  const milestones = tree.milestones.map((milestone) => {
    if (milestone.id === nodeId) {
      found = true
      return {
        ...milestone,
        title: patch.title ?? milestone.title,
        description: patch.description ?? milestone.description,
        successCriteria: patch.successCriteria ?? milestone.successCriteria,
        confirmed: false
      }
    }
    return {
      ...milestone,
      slices: milestone.slices.map((slice) => {
        if (slice.id === nodeId) {
          found = true
          return {
            ...slice,
            title: patch.title ?? slice.title,
            description: patch.description ?? slice.description,
            successCriteria: patch.successCriteria ?? slice.successCriteria,
            dependsOnSliceIds: patch.dependsOnSliceIds ?? slice.dependsOnSliceIds,
            confirmed: false
          }
        }
        return {
          ...slice,
          tasks: slice.tasks.map((task) => {
            if (task.id !== nodeId) return task
            found = true
            return {
              ...task,
              title: patch.title ?? task.title,
              description: patch.description ?? task.description,
              successCriteria: patch.successCriteria ?? task.successCriteria,
              contextMarkdown: patch.contextMarkdown ?? task.contextMarkdown,
              abilityCode: patch.abilityCode ?? task.abilityCode,
              coreCode: patch.coreCode ?? task.coreCode,
              canRunInParallel: patch.canRunInParallel ?? task.canRunInParallel,
              referenceIds: patch.referenceIds ?? task.referenceIds,
              referenceReason: patch.referenceReason ?? task.referenceReason,
              requiredInputs: patch.requiredInputs ?? task.requiredInputs,
              dependsOnTaskIds: patch.dependsOnTaskIds ?? task.dependsOnTaskIds,
              confirmed: false
            }
          })
        }
      })
    }
  })

  return found ? { ...tree, revision, milestones } : null
}

/** Confirm one immutable tree node, returning null when the node id is absent. */
export function confirmExecutionTreeNode(
  tree: ExecutionTreeSnapshot,
  nodeId: string,
  revision: number
): ExecutionTreeSnapshot | null {
  let found = false
  const milestones = tree.milestones.map((milestone) => {
    if (milestone.id === nodeId) {
      found = true
      return { ...milestone, confirmed: true }
    }
    return {
      ...milestone,
      slices: milestone.slices.map((slice) => {
        if (slice.id === nodeId) {
          found = true
          return { ...slice, confirmed: true }
        }
        return {
          ...slice,
          tasks: slice.tasks.map((task) => {
            if (task.id !== nodeId) return task
            found = true
            return { ...task, confirmed: true }
          })
        }
      })
    }
  })

  return found ? { ...tree, revision, milestones } : null
}

export function confirmEntireExecutionTree(
  tree: ExecutionTreeSnapshot,
  revision: number
): ExecutionTreeSnapshot {
  return {
    ...tree,
    revision,
    milestones: tree.milestones.map((milestone) => ({
      ...milestone,
      confirmed: true,
      slices: milestone.slices.map((slice) => ({
        ...slice,
        confirmed: true,
        tasks: slice.tasks.map((task) => ({ ...task, confirmed: true }))
      }))
    }))
  }
}
