import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  inspectJobRuntimeQuota,
  isTerminalJobStatus,
  JobRuntimeQuotaExceededError,
  jobRuntimeDir,
  resolveJobRuntimeScope,
  threadRuntimeDir
} from '../../src/server/runtime/cleanup'
import { normalizeTurnError } from '../../src/shared/turn-errors'

test('isTerminalJobStatus matches completed lifecycle states', () => {
  assert.equal(isTerminalJobStatus('completed'), true)
  assert.equal(isTerminalJobStatus('failed'), true)
  assert.equal(isTerminalJobStatus('cancelled'), true)
  assert.equal(isTerminalJobStatus('paused'), false)
  assert.equal(isTerminalJobStatus('running'), false)
})

test('runtime dir helpers resolve under data/runtimes', () => {
  const dataDir = join('tmp', 'codetask-data')
  assert.equal(threadRuntimeDir(dataDir, 'thread-1'), join(dataDir, 'runtimes', 'thread-1'))
  assert.equal(
    jobRuntimeDir(dataDir, 'thread-1', 'job-1'),
    join(dataDir, 'runtimes', 'thread-1', 'jobs', 'job-1')
  )
})

test('runtime quota resolves the enclosing Job and reports soft and hard limits', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-runtime-quota-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const runtimeRoot = join(jobRuntimeDir(dataDir, 'thread-1', 'job-1'), 'tasks', 'task-1', 'codex')
  mkdirSync(runtimeRoot, { recursive: true })
  writeFileSync(join(runtimeRoot, 'payload.bin'), Buffer.alloc(80))

  assert.deepEqual(resolveJobRuntimeScope(dataDir, runtimeRoot), {
    threadId: 'thread-1',
    jobId: 'job-1',
    jobRoot: jobRuntimeDir(dataDir, 'thread-1', 'job-1')
  })
  const soft = await inspectJobRuntimeQuota({ dataDir, runtimeRoot, maxBytes: 100 })
  assert.equal(soft.bytes, 80)
  assert.equal(soft.softExceeded, true)
  assert.equal(soft.hardExceeded, false)

  writeFileSync(join(runtimeRoot, 'overflow.bin'), Buffer.alloc(20))
  const hard = await inspectJobRuntimeQuota({ dataDir, runtimeRoot, maxBytes: 100 })
  assert.equal(hard.bytes, 100)
  assert.equal(hard.hardExceeded, true)
})

test('runtime quota ignores roots outside the managed runtime tree', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-runtime-quota-'))
  const outside = mkdtempSync(join(tmpdir(), 'codetask-runtime-outside-'))
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  writeFileSync(join(outside, 'payload.bin'), Buffer.alloc(100))

  const result = await inspectJobRuntimeQuota({ dataDir, runtimeRoot: outside, maxBytes: 10 })
  assert.equal(result.scope, null)
  assert.equal(result.hardExceeded, false)
})

test('runtime quota errors persist as a deterministic non-generic TurnError code', () => {
  const normalized = normalizeTurnError(new JobRuntimeQuotaExceededError('job-1', 101, 100))
  assert.equal(normalized.code, 'runtime.quota_exceeded')
  assert.deepEqual(normalized.params, { jobId: 'job-1', actualBytes: 101, maxBytes: 100 })
})
