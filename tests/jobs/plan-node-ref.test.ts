import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePlanNode } from '../../src/server/jobs/plan-node-ref'

const samplePlan = {
  tasks: [{ id: 'm1-s2-t3', milestoneIndex: 1, sliceIndex: 2, taskIndex: 3 }]
}

test('resolvePlanNode parses milestone refs like m1', () => {
  assert.deepEqual(resolvePlanNode(samplePlan, 'm1'), {
    kind: 'milestone',
    indices: [0]
  })
})

test('resolvePlanNode parses slice refs like m1-s2', () => {
  assert.deepEqual(resolvePlanNode(samplePlan, 'm1-s2'), {
    kind: 'slice',
    indices: [0, 1]
  })
})

test('resolvePlanNode prefers task ids like m1-s2-t3 over slice refs', () => {
  assert.deepEqual(resolvePlanNode(samplePlan, 'm1-s2-t3'), {
    kind: 'task',
    indices: [0, 1, 2]
  })
  assert.deepEqual(resolvePlanNode(samplePlan, 'm1-s2'), {
    kind: 'slice',
    indices: [0, 1]
  })
})

test('resolvePlanNode rejects invalid milestone refs', () => {
  assert.equal(resolvePlanNode(samplePlan, 'mx'), null)
})
