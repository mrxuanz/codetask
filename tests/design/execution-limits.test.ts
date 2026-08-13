import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findExecutionTreeLimitViolation,
  MAX_EXECUTION_TASKS,
  MAX_TASK_CONTEXT_CHARS,
  type ExecutionTreeSnapshot
} from '@codetask/contracts'
import {
  normalizeRegisteredPlan,
  validatePlanShape
} from '../../packages/server-core/src/modules/design/planning/mcp/normalize.ts'

function treeWithContext(contextMarkdown: string): ExecutionTreeSnapshot {
  return {
    treeId: 'tree-limit-test',
    planningSessionId: 'planning-limit-test',
    revision: 1,
    milestones: [
      {
        id: 'milestone-1',
        title: 'Milestone',
        description: 'Description',
        successCriteria: 'Done',
        confirmed: true,
        slices: [
          {
            id: 'slice-1',
            milestoneId: 'milestone-1',
            title: 'Slice',
            description: 'Description',
            successCriteria: 'Done',
            dependsOnSliceIds: [],
            confirmed: true,
            tasks: [
              {
                id: 'task-1',
                sliceId: 'slice-1',
                title: 'Task',
                description: 'Description',
                taskKind: 'implementation',
                abilityCode: 'general',
                coreCode: 'opencode',
                contextMarkdown,
                successCriteria: 'Done',
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

test('execution tree rejects a task context beyond the durable limit', () => {
  const violation = findExecutionTreeLimitViolation(
    treeWithContext('x'.repeat(MAX_TASK_CONTEXT_CHARS + 1))
  )
  assert.match(violation ?? '', /context/i)
})

test('planner rejects aggregate task counts before building a huge execution tree', () => {
  const tasks = Array.from({ length: MAX_EXECUTION_TASKS + 1 }, (_, index) => ({
    title: `Task ${index}`,
    description: 'Small task',
    taskKind: 'general-implementation',
    abilityCode: 'general',
    successCriteria: 'Done'
  }))
  const plan = normalizeRegisteredPlan({
    milestones: [
      {
        title: 'Milestone',
        successCriteria: 'Done',
        slices: [{ title: 'Slice', successCriteria: 'Done', tasks }]
      }
    ]
  })
  assert.throws(() => validatePlanShape(plan), /exceeds/)
})
