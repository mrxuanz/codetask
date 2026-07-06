import assert from 'node:assert/strict'
import test from 'node:test'
import { enqueueJobSseEvent } from '../../src/server/context/event-bus'
import type { JobSseEvent } from '../../src/server/jobs/types'

test('enqueueJobSseEvent coalesces task_progress events', () => {
  const queue: JobSseEvent[] = []
  enqueueJobSseEvent(queue, {
    event: 'task_progress',
    data: {
      taskProgress: { phase: 'running', status: 'running', currentIndex: 0, total: 1, tasks: [] }
    }
  })
  enqueueJobSseEvent(queue, {
    event: 'task_progress',
    data: {
      taskProgress: { phase: 'running', status: 'running', currentIndex: 1, total: 1, tasks: [] }
    }
  })
  assert.equal(queue.length, 1)
  assert.equal(queue[0].event, 'task_progress')
  if (queue[0].event === 'task_progress') {
    assert.equal(queue[0].data.taskProgress.currentIndex, 1)
  }
})

test('enqueueJobSseEvent preserves job_done', () => {
  const queue: JobSseEvent[] = []
  for (let i = 0; i < 70; i += 1) {
    enqueueJobSseEvent(queue, {
      event: 'task_progress',
      data: {
        taskProgress: {
          phase: 'running',
          status: 'running',
          currentIndex: i,
          total: 100,
          tasks: []
        }
      }
    })
  }
  enqueueJobSseEvent(queue, {
    event: 'job_done',
    data: {
      job: {
        id: 'j1',
        threadId: 't1',
        draftMessageId: 'd1',
        title: 't',
        summary: '',
        status: 'completed',
        planProgress: {
          phase: 'idle',
          status: 'completed',
          contextsRegistered: 0,
          contextsTotal: 0
        },
        taskProgress: {
          phase: 'completed',
          status: 'completed',
          currentIndex: 0,
          total: 0,
          tasks: []
        },
        createdAt: 0,
        updatedAt: 0
      }
    }
  })
  assert.ok(queue.some((event) => event.event === 'job_done'))
})
