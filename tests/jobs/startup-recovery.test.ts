import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveStaleExecutionJobAction,
  readPausingAttempt,
  withPausingAttempt
} from '../../src/server/jobs/execution-recovery'
import { pausingAttemptKey } from '../../src/server/jobs/recovery-limits'

test('resolveStaleExecutionJobAction keeps user paused jobs untouched', () => {
  assert.equal(resolveStaleExecutionJobAction({ status: 'paused' }), 'noop')
})

test('resolveStaleExecutionJobAction finalizes interrupted user pausing', () => {
  assert.equal(resolveStaleExecutionJobAction({ status: 'pausing' }), 'finalize-user-pause')
})

test('resolveStaleExecutionJobAction resumes interrupted running jobs', () => {
  assert.equal(resolveStaleExecutionJobAction({ status: 'running' }), 'resume-running')
})

test('pausing attempt counters persist on task progress', () => {
  const jobId = 'job-1'
  const base = { tasks: [], phase: 'running', status: 'running' } as never
  assert.equal(readPausingAttempt(base, jobId), 0)
  const next = withPausingAttempt(base, jobId, 2)
  assert.equal(next.repairGenerations?.[pausingAttemptKey(jobId)], 2)
})
