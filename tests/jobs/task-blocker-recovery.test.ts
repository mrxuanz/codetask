import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyTaskOutcome } from '../../src/server/legacy-control-plane/task-blocker/classify'
import { isInfraTurnError } from '../../src/shared/turn-errors/policy.ts'
import { createTurnError } from '../../src/shared/turn-errors/turn-error.ts'
import {
  MAX_TASK_INFRA_RETRIES,
  applyTaskInfraRetryItem,
  resolveTaskInfraRecovery,
  resolveTaskRecoveryAction
} from '../../src/server/legacy-control-plane/task-blocker/recovery'
import { injectTaskDependencyPrepTask } from '../../src/server/legacy-control-plane/repair-tasks'
import type { SavedJobPlan } from '../../src/server/planner/plan-types'
import type { TaskProgressDto } from '../../src/server/legacy-control-plane/types'

const infraPacket = {
  status: 'blocked' as const,
  summary:
    'Unable to read ResultPanel.vue — all Read, Grep, and Shell tool calls returned Aborted.',
  changedFiles: [] as string[],
  evidence: [
    'Read on src/ResultPanel.vue → Error: Aborted',
    'Grep for spriteResult → Error: Aborted',
    'Shell ls returned no output and unknown exit status'
  ],
  validation: { ran: false, outcome: 'skipped' as const },
  blockers: ['All workspace tools (Read, Grep, Shell) are aborting/failing']
}

test('isInfraTurnError detects ACP authenticate failure by code', () => {
  assert.equal(isInfraTurnError(createTurnError('provider.cursor.acp_authenticate_failed')), true)
})

test('resolveTaskInfraRecovery schedules infra retry for ACP authenticate Internal error', () => {
  const error = createTurnError('provider.cursor.acp_authenticate_failed', {
    detail: 'Internal error'
  })
  const progress = {
    phase: 'running' as const,
    status: 'running' as const,
    currentIndex: 0,
    total: 1,
    tasks: []
  }
  const action = resolveTaskInfraRecovery({
    taskId: 'm1-s1-t1',
    taskProgress: progress,
    message: error.message,
    error
  })
  assert.equal(action.action, 'infra-retry')
})

test('classifyTaskOutcome detects infra tool abort as high-confidence infra', () => {
  const result = classifyTaskOutcome(infraPacket)
  assert.equal(result.kind, 'infra')
  assert.equal(result.confidence, 'high')
  assert.equal(result.source, 'classifier')
})

test('classifyTaskOutcome detects API key blockers as dependency-human', () => {
  const result = classifyTaskOutcome({
    status: 'blocked',
    summary: 'Cannot call OpenAI API',
    changedFiles: [],
    evidence: ['OPENAI_API_KEY missing from workspace env'],
    validation: { ran: false, outcome: 'not-applicable' },
    blockers: ['OPENAI_API_KEY missing — operator must configure credentials']
  })
  assert.equal(result.kind, 'dependency-human')
})

test('classifyTaskOutcome detects missing module as dependency-prep', () => {
  const result = classifyTaskOutcome({
    status: 'blocked',
    summary: 'spriteExtractor module not found in workspace',
    changedFiles: [],
    evidence: ['src/lib/spriteExtractor.ts does not exist'],
    validation: { ran: false, outcome: 'not-applicable' },
    blockers: ['Missing file src/lib/spriteExtractor.ts']
  })
  assert.equal(result.kind, 'dependency-prep')
})

test('resolveTaskRecoveryAction schedules infra retry with generation counter', () => {
  const progress: TaskProgressDto = {
    phase: 'running',
    status: 'running',
    currentIndex: 0,
    total: 1,
    tasks: []
  }
  const action = resolveTaskRecoveryAction({
    packet: infraPacket,
    taskId: 'm2-s2-t3',
    taskProgress: progress
  })
  assert.equal(action.action, 'infra-retry')
  if (action.action !== 'infra-retry') return
  assert.equal(action.attempt, 1)
  assert.equal(action.maxAttempts, MAX_TASK_INFRA_RETRIES)
})

test('resolveTaskInfraRecovery schedules infra retry for evidence timeout via TurnError code', () => {
  const progress: TaskProgressDto = {
    phase: 'running',
    status: 'running',
    currentIndex: 0,
    total: 1,
    tasks: []
  }
  const error = createTurnError('task.evidence_timeout', {
    params: { taskId: 'm2-s2-t4' }
  })
  const action = resolveTaskInfraRecovery({
    taskId: 'm2-s2-t4',
    taskProgress: progress,
    message: error.message,
    error
  })
  assert.equal(action.action, 'infra-retry')
  if (action.action !== 'infra-retry') return
  assert.equal(action.attempt, 1)
  assert.equal(action.classification.kind, 'infra')
})

test('resolveTaskInfraRecovery terminal-fails non-retryable errors that are not evidence miss', () => {
  const progress: TaskProgressDto = {
    phase: 'running',
    status: 'running',
    currentIndex: 0,
    total: 1,
    tasks: []
  }
  const error = createTurnError('provider.cli_auth_failed')
  const action = resolveTaskInfraRecovery({
    taskId: 'm2-s2-t4',
    taskProgress: progress,
    message: error.message,
    error
  })
  assert.equal(action.action, 'terminal-fail')
})

test('resolveTaskRecoveryAction stops infra retry after max attempts', () => {
  const progress: TaskProgressDto = {
    phase: 'running',
    status: 'running',
    currentIndex: 0,
    total: 1,
    tasks: [],
    repairGenerations: {
      'task-infra:m2-s2-t3': MAX_TASK_INFRA_RETRIES
    }
  }
  const action = resolveTaskRecoveryAction({
    packet: infraPacket,
    taskId: 'm2-s2-t3',
    taskProgress: progress
  })
  assert.equal(action.action, 'terminal-fail')
})

test('applyTaskInfraRetryItem re-queues task without marking evidence complete', () => {
  const items = applyTaskInfraRetryItem(
    [
      {
        id: 'm2-s2-t3',
        title: 'Blocked task',
        status: 'running',
        executionStatus: 'running'
      }
    ],
    'm2-s2-t3',
    infraPacket,
    classifyTaskOutcome(infraPacket),
    1,
    MAX_TASK_INFRA_RETRIES
  )
  assert.equal(items[0]?.status, 'queued')
  assert.equal(items[0]?.executionStatus, 'retry-queued')
  assert.equal(items[0]?.evidenceStatus, null)
  assert.equal(items[0]?.error?.code, 'task.infra_retry')
  assert.equal(items[0]?.error?.params?.attempt, 1)
  assert.equal(items[0]?.error?.params?.maxAttempts, MAX_TASK_INFRA_RETRIES)
})

test('injectTaskDependencyPrepTask wires blocked task to depend on prep task', () => {
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
        title: 'Blocked',
        description: 'needs file',
        taskKind: 'code',
        abilityCode: 'implement',
        contextMarkdown: '',
        successCriteria: 'ok'
      }
    ]
  } as unknown as SavedJobPlan

  const injection = injectTaskDependencyPrepTask({
    plan,
    blockedTaskId: 'm1-s1-t1',
    summary: 'Missing i18n key',
    blockers: ['spriteResult.detectedCount missing in i18n.ts'],
    generation: 1
  })
  assert.equal(injection.created, 1)
  const prepId = injection.newTaskIds[0]
  assert.ok(prepId)
  const blocked = plan.tasks.find((task) => task.id === 'm1-s1-t1')
  assert.ok(blocked?.dependsOnTaskRefs?.includes(prepId))
  const prep = plan.tasks.find((task) => task.id === prepId)
  assert.match(prep?.title ?? '', /^\[PREP\]/)
})
