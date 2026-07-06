import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isTerminalJobStatus,
  jobRuntimeDir,
  threadRuntimeDir
} from '../../src/server/runtime/cleanup'

test('isTerminalJobStatus matches completed lifecycle states', () => {
  assert.equal(isTerminalJobStatus('completed'), true)
  assert.equal(isTerminalJobStatus('failed'), true)
  assert.equal(isTerminalJobStatus('cancelled'), true)
  assert.equal(isTerminalJobStatus('paused'), false)
  assert.equal(isTerminalJobStatus('running'), false)
})

test('runtime dir helpers resolve under data/runtimes', () => {
  const dataDir = '/tmp/codetask-data'
  assert.equal(threadRuntimeDir(dataDir, 'thread-1'), '/tmp/codetask-data/runtimes/thread-1')
  assert.equal(
    jobRuntimeDir(dataDir, 'thread-1', 'job-1'),
    '/tmp/codetask-data/runtimes/thread-1/jobs/job-1'
  )
})
