import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { SqliteDomainJobRepository } from '../../../src/server/adapters/sqlite/index.ts'
import { createApplication } from '../../../src/server/composition/create-application.ts'
import {
  asProjectId,
  asThreadId,
  asUserId,
  createThread
} from '../../../src/server/core/domain/conversation/index.ts'
import { createJob } from '../../../src/server/core/domain/jobs/index.ts'
import {
  createTask,
  createTaskAttempt
} from '../../../src/server/core/domain/tasks/index.ts'
import type { ProjectedTask } from '../../../src/server/core/application/ports/task-projection'

describe('sqlite task/attempt domain adapters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codetask-task-attempt-domain-'))
  const sqlitePath = join(dir, 'kernel.sqlite')
  const app = createApplication({ mode: 'sqlite', sqlitePath })

  after(() => {
    app.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('projects tasks by generation and tracks attempt lifecycle', async () => {
    const threadId = 'thread-1'
    const jobId = 'job-1'
    const taskId = 'task-1'

    await app.threads.save(
      createThread({
        id: asThreadId(threadId),
        projectId: asProjectId('project-1'),
        ownerUserId: asUserId('user-1')
      })
    )
    ;(app.jobs as SqliteDomainJobRepository).bindThread(jobId, threadId)
    await app.jobs.save(
      createJob({
        id: jobId,
        status: 'queued',
        executionGeneration: 1,
        planRevision: 1,
        stateRevision: 0
      })
    )

    const projected: ProjectedTask = {
      jobId,
      executionGeneration: 1,
      task: createTask({
        id: taskId,
        title: 'First task',
        dependencyIds: []
      }),
      status: 'pending',
      sliceId: 'slice-1',
      milestoneId: 'milestone-1'
    }
    await app.tasks.save(projected)

    const got = await app.tasks.get(jobId, 1, taskId)
    assert.deepEqual(got, projected)

    const listed = await app.tasks.listForJob(jobId, 1)
    assert.equal(listed.length, 1)
    assert.deepEqual(listed[0], projected)

    assert.equal((await app.tasks.listForJob(jobId, 2)).length, 0)
    assert.equal(await app.tasks.get(jobId, 2, taskId), undefined)

    const attempt = createTaskAttempt({
      id: 'attempt-1',
      taskId,
      executionGeneration: 1,
      status: 'pending',
      idempotencyKey: `${taskId}:1`
    })
    await app.attempts.save(attempt, { jobId })

    const loaded = await app.attempts.get(attempt.id)
    assert.deepEqual(loaded, attempt)

    const forTask = await app.attempts.listForTask(jobId, taskId, 1)
    assert.equal(forTask.length, 1)
    assert.deepEqual(forTask[0], attempt)

    let nonTerminal = await app.attempts.listNonTerminal()
    assert.equal(nonTerminal.length, 1)
    assert.equal(nonTerminal[0]?.id, attempt.id)
    assert.equal(nonTerminal[0]?.jobId, jobId)

    await app.attempts.save(
      { ...attempt, status: 'running' },
      { jobId }
    )
    nonTerminal = await app.attempts.listNonTerminal()
    assert.equal(nonTerminal.length, 1)
    assert.equal(nonTerminal[0]?.status, 'running')

    await app.attempts.save(
      { ...attempt, status: 'succeeded', resultHash: 'hash-1' },
      { jobId }
    )
    nonTerminal = await app.attempts.listNonTerminal()
    assert.equal(nonTerminal.length, 0)

    const succeeded = await app.attempts.get(attempt.id)
    assert.equal(succeeded?.status, 'succeeded')
    assert.equal(succeeded?.resultHash, 'hash-1')
  })
})
