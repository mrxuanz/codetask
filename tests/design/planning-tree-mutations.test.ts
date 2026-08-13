import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ExecutionTreeSnapshot } from '@codetask/contracts'
import {
  confirmEntireExecutionTree,
  confirmExecutionTreeNode,
  patchExecutionTreeNode
} from '../../packages/server-core/src/modules/design/planning/domain/tree-mutations.ts'

function executionTree(): ExecutionTreeSnapshot {
  return {
    treeId: 'tree-1',
    planningSessionId: 'plan-1',
    revision: 7,
    milestones: [
      {
        id: 'milestone-1',
        title: 'Milestone',
        description: 'milestone description',
        successCriteria: 'milestone done',
        confirmed: true,
        slices: [
          {
            id: 'slice-1',
            milestoneId: 'milestone-1',
            title: 'Slice',
            description: 'slice description',
            successCriteria: 'slice done',
            dependsOnSliceIds: [],
            confirmed: true,
            tasks: [
              {
                id: 'task-1',
                sliceId: 'slice-1',
                title: 'Task',
                description: 'task description',
                taskKind: 'implementation',
                abilityCode: 'frontend',
                coreCode: 'codex',
                contextMarkdown: 'context',
                successCriteria: 'task done',
                referenceIds: [],
                referenceReason: '',
                requiredInputs: [],
                dependsOnTaskIds: [],
                canRunInParallel: false,
                confirmed: true
              }
            ]
          }
        ]
      }
    ]
  }
}

describe('planning tree mutations', () => {
  it('patches a task immutably and marks only that task unconfirmed', () => {
    const original = executionTree()
    const updated = patchExecutionTreeNode(
      original,
      'task-1',
      {
        expectedRevision: 7,
        title: 'Updated task',
        coreCode: 'opencode',
        referenceIds: ['ref-1'],
        canRunInParallel: true
      },
      8
    )

    assert.ok(updated)
    const task = updated.milestones[0]?.slices[0]?.tasks[0]
    assert.equal(updated.revision, 8)
    assert.equal(task?.title, 'Updated task')
    assert.equal(task?.coreCode, 'opencode')
    assert.deepEqual(task?.referenceIds, ['ref-1'])
    assert.equal(task?.canRunInParallel, true)
    assert.equal(task?.confirmed, false)
    assert.equal(updated.milestones[0]?.confirmed, true)
    assert.equal(updated.milestones[0]?.slices[0]?.confirmed, true)
    assert.equal(original.milestones[0]?.slices[0]?.tasks[0]?.title, 'Task')
    assert.equal(original.revision, 7)
  })

  it('applies milestone and slice fields at their matching levels', () => {
    const original = executionTree()
    const milestone = patchExecutionTreeNode(
      original,
      'milestone-1',
      { expectedRevision: 7, successCriteria: 'new milestone criteria' },
      8
    )
    const slice = patchExecutionTreeNode(
      original,
      'slice-1',
      { expectedRevision: 7, dependsOnSliceIds: ['slice-0'] },
      8
    )

    assert.equal(milestone?.milestones[0]?.successCriteria, 'new milestone criteria')
    assert.equal(milestone?.milestones[0]?.confirmed, false)
    assert.deepEqual(slice?.milestones[0]?.slices[0]?.dependsOnSliceIds, ['slice-0'])
    assert.equal(slice?.milestones[0]?.slices[0]?.confirmed, false)
  })

  it('returns null when a patch or confirmation targets an unknown node', () => {
    const tree = executionTree()

    assert.equal(
      patchExecutionTreeNode(tree, 'missing', { expectedRevision: 7, title: 'unused' }, 8),
      null
    )
    assert.equal(confirmExecutionTreeNode(tree, 'missing', 8), null)
  })

  it('confirms one node or the complete tree with the requested revision', () => {
    const tree = executionTree()
    tree.milestones[0]!.confirmed = false
    tree.milestones[0]!.slices[0]!.confirmed = false
    tree.milestones[0]!.slices[0]!.tasks[0]!.confirmed = false

    const one = confirmExecutionTreeNode(tree, 'task-1', 8)
    assert.equal(one?.milestones[0]?.confirmed, false)
    assert.equal(one?.milestones[0]?.slices[0]?.confirmed, false)
    assert.equal(one?.milestones[0]?.slices[0]?.tasks[0]?.confirmed, true)

    const all = confirmEntireExecutionTree(tree, 9)
    assert.equal(all.revision, 9)
    assert.equal(all.milestones[0]?.confirmed, true)
    assert.equal(all.milestones[0]?.slices[0]?.confirmed, true)
    assert.equal(all.milestones[0]?.slices[0]?.tasks[0]?.confirmed, true)
  })
})
