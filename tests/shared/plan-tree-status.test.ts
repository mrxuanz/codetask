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
