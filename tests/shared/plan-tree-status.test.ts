import assert from 'node:assert/strict'
import test from 'node:test'
import { buildUnifiedProgressTree } from '../../src/shared/plan-tree.ts'

const minimalPlan = {
  milestones: [
    {
      title: 'M1',
      slices: [
        {
          title: 'S1',
          tasks: [{ title: 'T1', abilityCode: 'scaffolding' }]
        }
      ]
    }
  ],
  tasks: [
    {
      id: 'm1-s1-t1',
      milestoneIndex: 0,
      sliceIndex: 0,
      taskIndex: 0,
      title: 'T1',
      description: 'd',
      taskKind: 'scaffolding',
      abilityCode: 'scaffolding',
      contextMarkdown: 'ctx'
    }
  ]
}

test('buildUnifiedProgressTree marks currentTaskId as in_progress while job is running', () => {
  const tree = buildUnifiedProgressTree({
    jobId: 'job-1',
    title: 'Job',
    jobStatus: 'running',
    plan: minimalPlan,
    currentTaskId: 'm1-s1-t1',
    taskProgressItems: [
      {
        id: 'm1-s1-t1',
        title: 'T1',
        status: 'queued',
        executionStatus: 'queued'
      }
    ]
  })

  const task = tree.milestones[0]?.slices[0]?.tasks[0]
  assert.equal(task?.status, 'in_progress')
  assert.equal(task?.executionStatus, 'running')
  assert.equal(tree.milestones[0]?.status, 'in_progress')
  assert.equal(tree.milestones[0]?.slices[0]?.status, 'in_progress')
})

test('buildUnifiedProgressTree keeps milestone in_progress while slice is verifying', () => {
  const tree = buildUnifiedProgressTree({
    jobId: 'job-1',
    title: 'Job',
    jobStatus: 'running',
    plan: minimalPlan,
    taskProgressItems: [
      {
        id: 'm1-s1-t1',
        title: 'T1',
        status: 'completed',
        executionStatus: 'completed'
      }
    ],
    verification: {
      slices: [{ id: 'm1-s1', runtimeStatus: 'verifying', verificationStatus: 'verifying' }]
    }
  })

  assert.equal(tree.milestones[0]?.slices[0]?.status, 'completed')
  assert.equal(tree.milestones[0]?.slices[0]?.runtimeStatus, 'verifying')
  assert.equal(tree.milestones[0]?.status, 'in_progress')
  assert.notEqual(tree.milestones[0]?.status, 'completed')
})

test('buildUnifiedProgressTree marks milestone completed only after slice verification passes', () => {
  const tree = buildUnifiedProgressTree({
    jobId: 'job-1',
    title: 'Job',
    jobStatus: 'running',
    plan: minimalPlan,
    taskProgressItems: [
      {
        id: 'm1-s1-t1',
        title: 'T1',
        status: 'completed',
        executionStatus: 'completed'
      }
    ],
    verification: {
      slices: [{ id: 'm1-s1', runtimeStatus: 'progress-ok', verificationStatus: 'passed' }]
    }
  })

  assert.equal(tree.milestones[0]?.status, 'completed')
})

test('buildUnifiedProgressTree marks currentTaskId as paused while job is paused', () => {
  const tree = buildUnifiedProgressTree({
    jobId: 'job-1',
    title: 'Job',
    jobStatus: 'paused',
    plan: minimalPlan,
    currentTaskId: 'm1-s1-t1',
    taskProgressItems: [
      {
        id: 'm1-s1-t1',
        title: 'T1',
        status: 'queued',
        executionStatus: 'queued'
      }
    ],
    verification: {
      slices: [{ id: 'm1-s1', runtimeStatus: 'running', verificationStatus: null }]
    }
  })

  const task = tree.milestones[0]?.slices[0]?.tasks[0]
  assert.equal(task?.status, 'paused')
  assert.equal(task?.executionStatus, 'paused')
  assert.equal(tree.milestones[0]?.status, 'paused')
  assert.equal(tree.milestones[0]?.slices[0]?.status, 'paused')
  assert.notEqual(tree.milestones[0]?.slices[0]?.runtimeStatus, 'running')
})

test('planning status follows exact task context instead of completed count order', () => {
  const plan = structuredClone(minimalPlan)
  plan.milestones[0]!.slices[0]!.tasks.push({ title: 'T2', abilityCode: 'scaffolding' })
  plan.tasks[0]!.contextMarkdown = ''
  plan.tasks.push({
    ...plan.tasks[0]!,
    id: 'm1-s1-t2',
    taskIndex: 1,
    title: 'T2',
    contextMarkdown: 'second task context'
  })

  const tree = buildUnifiedProgressTree({
    jobId: 'job-1',
    title: 'Job',
    jobStatus: 'planning',
    plan
  })
  const tasks = tree.milestones[0]?.slices[0]?.tasks ?? []
  assert.equal(tasks[0]?.planStatus, 'pending')
  assert.equal(tasks[1]?.planStatus, 'planned')
})
