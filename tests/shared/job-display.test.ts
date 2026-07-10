import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatExecutionQueueLabel,
  isExecutionDisplayStatus,
  resolveJobDisplay,
  resolveJobStatusBadgeClass,
  resolveJobStatusDisplay
} from '../../src/shared/job-display'

test('isExecutionDisplayStatus recognizes execution queue statuses', () => {
  assert.equal(isExecutionDisplayStatus('pending'), true)
  assert.equal(isExecutionDisplayStatus('pausing'), true)
  assert.equal(isExecutionDisplayStatus('planning'), false)
})

test('resolveJobStatusDisplay maps pausing lifecycle', () => {
  const display = resolveJobStatusDisplay('pausing')
  assert.equal(display.lifecycle, 'pausing')
  assert.equal(display.badge, 'workspace.tasks.status.pausing')
})

test('resolveJobDisplay matches status-only helper', () => {
  const fromJob = resolveJobDisplay({
    id: 'job-1',
    threadId: 'thread-1',
    draftMessageId: 'draft-1',
    title: 'Demo',
    summary: '',
    status: 'pending',
    planProgress: {} as never,
    taskProgress: {} as never,
    abilities: [],
    createdAt: 0,
    updatedAt: 0
  })
  assert.deepEqual(fromJob, resolveJobStatusDisplay('pending'))
})

test('resolveJobStatusBadgeClass uses queue styling for pending', () => {
  assert.match(resolveJobStatusBadgeClass('pending'), /amber/)
})

test('formatExecutionQueueLabel prefers queue position copy', () => {
  const t = (key: string, params?: Record<string, unknown>): string =>
    key === 'workspace.tasks.queue.position'
      ? `#${params?.position}`
      : key
  assert.equal(formatExecutionQueueLabel(t, { position: 2, ahead: 1 }), '#2')
  assert.equal(
    formatExecutionQueueLabel(t, { position: 1, ahead: 0 }),
    'workspace.tasks.queue.next'
  )
})
