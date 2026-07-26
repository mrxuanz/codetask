import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TaskDomainError,
  createTask,
  createTaskAttempt,
  failAttempt,
  isTaskReady,
  markInconclusive,
  startAttempt,
  succeedAttempt,
  type AttemptStatus
} from '../../../src/server/core/domain/tasks/index.ts'

describe('isTaskReady', () => {
  it('ready when no dependencies', () => {
    const task = createTask({ id: 't1' })
    assert.equal(isTaskReady(task, new Set()), true)
  })

  it('ready when all dependencies completed', () => {
    const task = createTask({ id: 't3', dependencyIds: ['t1', 't2'] })
    assert.equal(isTaskReady(task, new Set(['t1', 't2', 't9'])), true)
  })

  it('not ready when a dependency is missing', () => {
    const task = createTask({ id: 't3', dependencyIds: ['t1', 't2'] })
    assert.equal(isTaskReady(task, new Set(['t1'])), false)
  })

  it('not ready when completed set is empty but deps exist', () => {
    const task = createTask({ id: 't2', dependencyIds: ['t1'] })
    assert.equal(isTaskReady(task, new Set()), false)
  })
})

describe('attempt transitions', () => {
  it('pending → running → succeeded', () => {
    const pending = createTaskAttempt({ id: 'a1', taskId: 't1' })
    const running = startAttempt(pending)
    assert.equal(running.status, 'running')
    const done = succeedAttempt(running, 'hash-abc')
    assert.equal(done.status, 'succeeded')
    assert.equal(done.resultHash, 'hash-abc')
  })

  it('running → failed', () => {
    const running = startAttempt(createTaskAttempt({ id: 'a1', taskId: 't1' }))
    const failed = failAttempt(running, 'task.worker_error')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.errorCode, 'task.worker_error')
  })

  it('running → inconclusive (not forged to succeeded)', () => {
    const running = startAttempt(createTaskAttempt({ id: 'a1', taskId: 't1' }))
    const inconclusive = markInconclusive(running)
    assert.equal(inconclusive.status, 'inconclusive')
    assert.notEqual(inconclusive.status, 'succeeded')
    assert.equal(inconclusive.resultHash, null)
  })

  it('attempt terminates once — further transitions throw', () => {
    const terminals: AttemptStatus[] = ['succeeded', 'failed', 'inconclusive']
    for (const status of terminals) {
      const attempt = createTaskAttempt({ id: 'a1', taskId: 't1', status })
      assert.throws(() => startAttempt(attempt), TaskDomainError)
      assert.throws(() => succeedAttempt(attempt, 'h'), TaskDomainError)
      assert.throws(() => failAttempt(attempt, 'e'), TaskDomainError)
      assert.throws(() => markInconclusive(attempt), (err: unknown) => {
        assert.ok(err instanceof TaskDomainError)
        assert.equal(err.code, 'task.attempt_already_terminal')
        return true
      })
    }
  })

  it('cannot succeed/fail/inconclusive from pending', () => {
    const pending = createTaskAttempt({ id: 'a1', taskId: 't1', status: 'pending' })
    assert.throws(() => succeedAttempt(pending, 'h'), TaskDomainError)
    assert.throws(() => failAttempt(pending, 'e'), TaskDomainError)
    assert.throws(() => markInconclusive(pending), TaskDomainError)
  })

  it('cannot start from running', () => {
    const running = createTaskAttempt({ id: 'a1', taskId: 't1', status: 'running' })
    assert.throws(() => startAttempt(running), TaskDomainError)
  })
})
