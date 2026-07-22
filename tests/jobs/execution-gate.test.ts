import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TASK_EVIDENCE_BASIC_FACTS_OK,
  applyTaskProgressToGate,
  buildGateStates,
  findNextReadyTask,
  reopenSliceVerificationForMissingVerdict
} from '../../src/server/legacy-control-plane/execution-gate'
import {
  injectSliceRepairTasks,
  injectTaskDependencyPrepTask,
  injectTaskImplementationRepairTask
} from '../../src/server/legacy-control-plane/repair-tasks'
import type { SavedJobPlan } from '../../src/server/planner/plan-types'

function createPlan(taskCount: number): SavedJobPlan {
  const nestedTasks = Array.from({ length: taskCount }, (_, index) => ({
    title: `Task ${index + 1}`,
    description: `Run task ${index + 1}`,
    taskKind: 'general-implementation',
    abilityCode: 'implement',
    dependsOnTaskRefs: [],
    successCriteria: 'done',
    canRunInParallel: false
  }))
  return {
    milestones: [
      {
        title: 'Milestone 1',
        successCriteria: 'done',
        slices: [
          {
            title: 'Slice 1',
            successCriteria: 'done',
            tasks: nestedTasks
          }
        ]
      }
    ],
    tasks: nestedTasks.map((task, index) => ({
      id: `m1-s1-t${index + 1}`,
      milestoneIndex: 1,
      sliceIndex: 1,
      taskIndex: index + 1,
      title: task.title,
      description: task.description,
      taskKind: task.taskKind,
      abilityCode: task.abilityCode,
      contextMarkdown: '',
      successCriteria: task.successCriteria,
      dependsOnTaskRefs: [],
      canRunInParallel: false
    }))
  }
}

function queuedItems(plan: SavedJobPlan): Array<{
  id: string
  status: string
  executionStatus: string
  evidenceStatus: string | null
}> {
  return plan.tasks.map((task) => ({
    id: task.id,
    status: 'queued',
    executionStatus: 'queued',
    evidenceStatus: null
  }))
}

function nextReadyId(plan: SavedJobPlan, items: ReturnType<typeof queuedItems>): string | null {
  const gate = buildGateStates(plan)
  applyTaskProgressToGate(gate.tasks, items)
  return findNextReadyTask(gate.slices, gate.tasks)?.id ?? null
}

function complete(
  items: ReturnType<typeof queuedItems>,
  taskId: string
): ReturnType<typeof queuedItems> {
  return items.map((item) =>
    item.id === taskId
      ? {
          ...item,
          status: 'completed',
          executionStatus: 'completed',
          evidenceStatus: TASK_EVIDENCE_BASIC_FACTS_OK
        }
      : item
  )
}

describe('execution gate dependency precedence', () => {
  it('reopens a passed slice whose durable verifier verdict is missing', () => {
    const gate = buildGateStates(createPlan(1))
    const slice = gate.slices[0]!
    slice.status = 'completed'
    slice.runtimeStatus = 'progress-ok'
    slice.verificationStatus = 'passed'

    assert.equal(reopenSliceVerificationForMissingVerdict(gate.slices, slice.id), true)
    assert.equal(slice.status, 'completed')
    assert.equal(slice.runtimeStatus, 'ready-for-verification')
    assert.equal(slice.verificationStatus, null)
    assert.equal(reopenSliceVerificationForMissingVerdict(gate.slices, slice.id), false)
  })

  it('preserves sequential fallback for ordinary tasks without explicit dependencies', () => {
    const plan = createPlan(2)
    let items = queuedItems(plan)

    assert.equal(nextReadyId(plan, items), 'm1-s1-t1')

    items = complete(items, 'm1-s1-t1')
    assert.equal(nextReadyId(plan, items), 'm1-s1-t2')
  })

  it('runs an appended implementation repair before its blocked task and implicit followers', () => {
    const plan = createPlan(3)
    const injection = injectTaskImplementationRepairTask({
      plan,
      blockedTaskId: 'm1-s1-t1',
      summary: 'Tests failed',
      blockers: ['Expected result did not match'],
      generation: 1
    })
    const repairId = injection.newTaskIds[0]!
    let items = queuedItems(plan).map((item) =>
      item.id === 'm1-s1-t1' ? { ...item, executionStatus: 'waiting-on-repair' } : item
    )

    assert.equal(nextReadyId(plan, items), repairId)

    items = complete(items, repairId)
    assert.equal(nextReadyId(plan, items), 'm1-s1-t1')
  })

  it('runs an appended dependency prep before a blocked middle task', () => {
    const plan = createPlan(3)
    const injection = injectTaskDependencyPrepTask({
      plan,
      blockedTaskId: 'm1-s1-t2',
      summary: 'Workspace prerequisite missing',
      blockers: ['Generated fixture is missing'],
      generation: 1
    })
    const prepId = injection.newTaskIds[0]!
    let items = complete(queuedItems(plan), 'm1-s1-t1').map((item) =>
      item.id === 'm1-s1-t2' ? { ...item, executionStatus: 'waiting-on-dependency' } : item
    )

    assert.equal(nextReadyId(plan, items), prepId)

    items = complete(items, prepId)
    assert.equal(nextReadyId(plan, items), 'm1-s1-t2')
  })

  it('supports recursively repairing a recovery task without reintroducing a cycle', () => {
    const plan = createPlan(2)
    const firstRepairId = injectTaskImplementationRepairTask({
      plan,
      blockedTaskId: 'm1-s1-t1',
      summary: 'Initial implementation failure',
      blockers: ['Tests failed'],
      generation: 1
    }).newTaskIds[0]!
    const nestedRepairId = injectTaskImplementationRepairTask({
      plan,
      blockedTaskId: firstRepairId,
      summary: 'Repair validation failure',
      blockers: ['Repair tests failed'],
      generation: 1
    }).newTaskIds[0]!
    const items = queuedItems(plan).map((item) => {
      if (item.id === 'm1-s1-t1' || item.id === firstRepairId) {
        return { ...item, executionStatus: 'waiting-on-repair' }
      }
      return item
    })

    assert.equal(nextReadyId(plan, items), nestedRepairId)
  })

  it('keeps slice-verifier repairs schedulable after completed slice tasks', () => {
    const plan = createPlan(2)
    const repairId = injectSliceRepairTasks({
      plan,
      sliceId: 'm1-s1',
      generation: 1,
      verdict: {
        status: 'needs-repair',
        confidence: 'high',
        summary: 'Evidence shows a regression',
        satisfiedSignals: [],
        missingSignals: ['regression fixed'],
        questionableClaims: [],
        evidenceTrace: [],
        repairSuggestions: [
          {
            reason: 'Regression remains',
            instruction: 'Fix the regression',
            targetTaskId: 'm1-s1-t2'
          }
        ]
      }
    }).newTaskIds[0]!
    let items = complete(queuedItems(plan), 'm1-s1-t1')
    items = complete(items, 'm1-s1-t2')

    assert.equal(nextReadyId(plan, items), repairId)
  })

  it('honors a forward explicit prerequisite across implicit sequential descendants', () => {
    const plan = createPlan(3)
    plan.tasks[0]!.dependsOnTaskRefs = ['m1-s1-t3']
    plan.milestones[0]!.slices[0]!.tasks[0]!.dependsOnTaskRefs = ['m1-s1-t3']

    assert.equal(nextReadyId(plan, queuedItems(plan)), 'm1-s1-t3')
  })

  it('does not hide a true explicit dependency cycle', () => {
    const plan = createPlan(2)
    plan.tasks[0]!.dependsOnTaskRefs = ['m1-s1-t2']
    plan.tasks[1]!.dependsOnTaskRefs = ['m1-s1-t1']
    plan.milestones[0]!.slices[0]!.tasks[0]!.dependsOnTaskRefs = ['m1-s1-t2']
    plan.milestones[0]!.slices[0]!.tasks[1]!.dependsOnTaskRefs = ['m1-s1-t1']

    assert.equal(nextReadyId(plan, queuedItems(plan)), null)
  })
})
