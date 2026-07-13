import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyTaskOutcome } from '../../src/server/legacy-control-plane/task-blocker/classify'
import {
  MAX_TASK_REPAIR_GENERATIONS,
  resolveTaskRecoveryAction
} from '../../src/server/legacy-control-plane/task-blocker/recovery'
import { injectTaskImplementationRepairTask } from '../../src/server/legacy-control-plane/repair-tasks'
import type { SavedJobPlan } from '../../src/server/planner/plan-types'
import type { TaskProgressDto } from '../../src/server/legacy-control-plane/types'
import { resolveVerifierInfraRecovery } from '../../src/server/legacy-control-plane/verification-recovery'

const implementationPacket = {
  status: 'failed' as const,
  summary: 'Unit tests failed for ResultPanel',
  changedFiles: ['src/ResultPanel.vue'],
  evidence: ['npm test -- ResultPanel → 2 failing assertions'],
  validation: { ran: true, outcome: 'failed' as const, command: 'npm test' },
  blockers: ['tests failed: expected count 3 received 0'],
  blockerKind: 'implementation' as const
}

test('classifyTaskOutcome detects test failures as implementation', () => {
  const result = classifyTaskOutcome(implementationPacket)
  assert.equal(result.kind, 'implementation')
  assert.equal(result.confidence, 'high')
})

test('resolveTaskRecoveryAction schedules implementation repair injection', () => {
  const progress: TaskProgressDto = {
    phase: 'running',
    status: 'running',
    currentIndex: 0,
    total: 1,
    tasks: []
  }
  const action = resolveTaskRecoveryAction({
    packet: implementationPacket,
    taskId: 'm1-s1-t1',
    taskProgress: progress
  })
  assert.equal(action.action, 'inject-repair')
  if (action.action !== 'inject-repair') return
  assert.equal(action.attempt, 1)
  assert.equal(action.maxAttempts, MAX_TASK_REPAIR_GENERATIONS)
})

test('injectTaskImplementationRepairTask wires blocked task to depend on repair task', () => {
  const plan = {
    milestones: [
      {
        slices: [
          {
            successCriteria: 'ok',
            tasks: [{ taskKind: 'code', successCriteria: 'ok' }]
          }
        ]
      }
    ],
    tasks: [
      {
        id: 'm1-s1-t1',
        milestoneIndex: 1,
        sliceIndex: 1,
        taskIndex: 1,
        title: 'Implement panel',
        description: 'build ui',
        taskKind: 'code',
        abilityCode: 'implement',
        contextMarkdown: '',
        successCriteria: 'ok'
      }
    ]
  } as unknown as SavedJobPlan

  const injection = injectTaskImplementationRepairTask({
    plan,
    blockedTaskId: 'm1-s1-t1',
    summary: implementationPacket.summary,
    blockers: implementationPacket.blockers ?? [],
    generation: 1
  })
  assert.equal(injection.created, 1)
  const repairId = injection.newTaskIds[0]
  assert.ok(repairId)
  const blocked = plan.tasks.find((task) => task.id === 'm1-s1-t1')
  assert.ok(blocked?.dependsOnTaskRefs?.includes(repairId))
  const repair = plan.tasks.find((task) => task.id === repairId)
  assert.match(repair?.title ?? '', /^\[REPAIR\]/)
  assert.deepEqual(repair?.dependsOnTaskRefs ?? [], [])
})

test('resolveVerifierInfraRecovery retries tool-miss up to limit', () => {
  const progress: TaskProgressDto = {
    phase: 'running',
    status: 'running',
    currentIndex: 0,
    total: 1,
    tasks: []
  }
  const first = resolveVerifierInfraRecovery({
    scope: 'slice',
    id: 'm1-s1',
    taskProgress: progress,
    message: '未收到 complete_slice_verification'
  })
  assert.equal(first.action, 'infra-retry')
})
