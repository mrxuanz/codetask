import assert from 'node:assert/strict'
import test from 'node:test'
import { JobExecutionRuntimeRegistry } from '../../src/server/context/job-execution-runtime'
import { isRestartInterruptedPause } from '../../src/server/legacy-control-plane/execution-recovery'
import { isExecutionInfraNotReadyError } from '../../src/server/legacy-control-plane/execution-infra-errors'
import { RuntimeRegistry } from '../../src/server/context/runtime-registry'

test('JobExecutionRuntimeRegistry blocks a second active loop for the same user', () => {
  const registry = new JobExecutionRuntimeRegistry()
  assert.equal(registry.tryStartLoop('job-a', 'alice'), true)
  assert.equal(registry.tryStartLoop('job-b', 'alice'), false)
  assert.equal(registry.findActiveLoopJobIdForUser('alice'), 'job-a')
  registry.endLoop('job-a')
  assert.equal(registry.tryStartLoop('job-b', 'alice'), true)
})

test('JobExecutionRuntimeRegistry blocks parallel loops globally at capacity 1', () => {
  const registry = new JobExecutionRuntimeRegistry()
  assert.equal(registry.tryStartLoop('job-a', 'alice'), true)
  assert.equal(registry.tryStartLoop('job-b', 'bob'), false)
  assert.equal(registry.findActiveLoopJobIdForUser('alice'), 'job-a')
  assert.equal(registry.findActiveLoopJobIdForUser('bob'), null)
})

test('RuntimeRegistry blocks a second planning session for the same user', () => {
  const registry = new RuntimeRegistry()
  assert.equal(registry.tryStartJobPlanning('session-a', 'alice'), true)
  assert.equal(registry.tryStartJobPlanning('session-b', 'alice'), false)
  assert.equal(registry.findActivePlanningIdForUser('alice'), 'session-a')
  registry.endJobPlanning('session-a')
  assert.equal(registry.tryStartJobPlanning('session-b', 'alice'), true)
})

test('RuntimeRegistry allows parallel planning for different users', () => {
  const registry = new RuntimeRegistry()
  assert.equal(registry.tryStartJobPlanning('session-a', 'alice'), true)
  assert.equal(registry.tryStartJobPlanning('session-b', 'bob'), true)
  assert.equal(registry.findActivePlanningIdForUser('alice'), 'session-a')
  assert.equal(registry.findActivePlanningIdForUser('bob'), 'session-b')
})

test('isRestartInterruptedPause is retired after P7 one-time migration', () => {
  const interrupted = {
    status: 'paused',
    lastError: null,
    taskProgress: {
      phase: 'running',
      status: 'running',
      currentIndex: 1,
      total: 3,
      currentTaskId: null,
      message: null,
      tasks: [{ id: 't1', title: 'T1', status: 'completed', executionStatus: 'completed' }]
    }
  } as Parameters<typeof isRestartInterruptedPause>[0]

  const userPaused = {
    ...interrupted,
    lastError: { code: 'job.paused', message: 'Paused', params: null }
  } as Parameters<typeof isRestartInterruptedPause>[0]

  assert.equal(isRestartInterruptedPause(interrupted), false)
  assert.equal(isRestartInterruptedPause(userPaused), false)
})

test('isRestartInterruptedPause does not auto-resume pause-human dependency', () => {
  const humanPaused = {
    status: 'paused',
    lastError: null,
    suspensionKind: null,
    taskProgress: {
      phase: 'running',
      status: 'running',
      currentIndex: 1,
      total: 2,
      currentTaskId: 't2',
      message: null,
      tasks: [
        { id: 't1', title: 'T1', status: 'completed', executionStatus: 'completed' },
        {
          id: 't2',
          title: 'T2',
          status: 'failed',
          executionStatus: 'failed',
          blockerKind: 'dependency-human',
          recoveryAction: 'pause-human'
        }
      ]
    }
  } as Parameters<typeof isRestartInterruptedPause>[0]

  assert.equal(isRestartInterruptedPause(humanPaused), false)

  const structured = {
    ...humanPaused,
    suspensionKind: 'human_dependency'
  } as Parameters<typeof isRestartInterruptedPause>[0]
  assert.equal(isRestartInterruptedPause(structured), false)
})

test('resolveStaleExecutionJobAction keeps pause-human as noop', async () => {
  const { resolveStaleExecutionJobAction } = await import(
    '../../src/server/legacy-control-plane/execution-recovery'
  )
  const humanPaused = {
    status: 'paused',
    lastError: null,
    taskProgress: {
      phase: 'running',
      status: 'running',
      currentIndex: 1,
      total: 2,
      currentTaskId: 't2',
      message: null,
      tasks: [
        {
          id: 't2',
          title: 'T2',
          status: 'failed',
          executionStatus: 'failed',
          blockerKind: 'dependency-human',
          recoveryAction: 'pause-human'
        }
      ]
    }
  } as Parameters<typeof resolveStaleExecutionJobAction>[0]

  assert.equal(resolveStaleExecutionJobAction(humanPaused), 'noop')
})

test('resolveStaleExecutionJobAction keeps legacy restart-looking paused as noop', async () => {
  const { resolveStaleExecutionJobAction } = await import(
    '../../src/server/legacy-control-plane/execution-recovery'
  )
  const interrupted = {
    status: 'paused',
    lastError: null,
    taskProgress: {
      phase: 'running',
      status: 'running',
      currentIndex: 1,
      total: 3,
      currentTaskId: 't2',
      message: null,
      tasks: [
        { id: 't1', title: 'T1', status: 'completed', executionStatus: 'completed' },
        { id: 't2', title: 'T2', status: 'queued', executionStatus: 'queued' }
      ]
    }
  } as Parameters<typeof resolveStaleExecutionJobAction>[0]

  const userPaused = {
    ...interrupted,
    lastError: { code: 'job.paused', message: 'Paused', params: null }
  } as Parameters<typeof resolveStaleExecutionJobAction>[0]

  assert.equal(resolveStaleExecutionJobAction(interrupted), 'noop')
  assert.equal(resolveStaleExecutionJobAction(userPaused), 'noop')
  assert.equal(resolveStaleExecutionJobAction({ status: 'running' } as never), 'resume-running')
})

test('isExecutionInfraNotReadyError detects MCP and sandbox startup failures', () => {
  assert.equal(
    isExecutionInfraNotReadyError(new Error('Task MCP backend port is not initialized')),
    true
  )
  assert.equal(isExecutionInfraNotReadyError(new Error('workflow.failed_block')), false)
})
