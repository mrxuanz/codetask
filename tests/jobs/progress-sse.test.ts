import assert from 'node:assert/strict'
import test from 'node:test'
import { slimJobForSse, slimTaskProgressForSse } from '../../src/server/legacy-control-plane/progress-sse'
import type { TaskProgressDto, ThreadJobDto } from '../../src/server/legacy-control-plane/types'

test('slimTaskProgressForSse strips evidence lines and verdict traces', () => {
  const progress: TaskProgressDto = {
    phase: 'running',
    status: 'running',
    currentIndex: 0,
    total: 1,
    tasks: [
      {
        id: 't1',
        title: 'Task',
        status: 'completed',
        evidence: {
          status: 'completed',
          summary: 'done',
          changedFiles: ['a.ts'],
          evidence: ['line-1', 'line-2'],
          validation: { ran: true, outcome: 'passed' }
        }
      }
    ],
    slices: [
      {
        id: 's1',
        verdict: {
          status: 'passed',
          confidence: 'high',
          summary: 'ok',
          evidenceTrace: ['trace-1', 'trace-2'],
          satisfiedSignals: [],
          missingSignals: []
        }
      }
    ]
  }

  const slim = slimTaskProgressForSse(progress)
  assert.deepEqual(slim.tasks[0]?.evidence?.evidence, [])
  assert.equal(slim.tasks[0]?.evidence?.evidenceLineCount, 2)
  assert.deepEqual(slim.slices?.[0]?.verdict?.evidenceTrace, [])
})

test('slimJobForSse slims embedded taskProgress only', () => {
  const job = {
    id: 'j1',
    threadId: 't1',
    draftMessageId: 'd1',
    title: 'Job',
    summary: '',
    status: 'running',
    planProgress: { phase: 'idle', status: 'completed', contextsRegistered: 1, contextsTotal: 1 },
    taskProgress: {
      phase: 'running',
      status: 'running',
      currentIndex: 0,
      total: 1,
      tasks: [
        {
          id: 't1',
          title: 'Task',
          status: 'running',
          evidence: {
            status: 'completed',
            summary: 'x',
            changedFiles: [],
            evidence: ['big'],
            validation: { ran: true, outcome: 'passed' }
          }
        }
      ]
    },
    createdAt: 0,
    updatedAt: 0
  } satisfies ThreadJobDto

  const slim = slimJobForSse(job)
  assert.deepEqual(slim.taskProgress.tasks[0]?.evidence?.evidence, [])
  assert.equal(slim.planProgress.contextsRegistered, 1)
})
