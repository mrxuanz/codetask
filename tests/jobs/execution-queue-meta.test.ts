import assert from 'node:assert/strict'
import test from 'node:test'
import { computeExecutionQueueMeta } from '../../src/server/jobs/execution-queue-meta'

test('computeExecutionQueueMeta returns FIFO position and ahead count', () => {
  const pending = ['job-a', 'job-b', 'job-c']
  assert.deepEqual(computeExecutionQueueMeta('job-a', pending), {
    position: 1,
    ahead: 0
  })
  assert.deepEqual(computeExecutionQueueMeta('job-b', pending), {
    position: 2,
    ahead: 1
  })
})

test('computeExecutionQueueMeta returns undefined for non-pending job id', () => {
  assert.equal(computeExecutionQueueMeta('job-x', ['job-a']), undefined)
})
