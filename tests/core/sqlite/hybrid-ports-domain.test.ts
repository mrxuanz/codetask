import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { asVerificationAttemptId } from '../../../src/server/core/domain/verification/types.ts'
import type { VerificationAttempt } from '../../../src/server/core/domain/verification/types.ts'
import type { RetainedArtifact } from '../../../src/server/core/domain/retention/types.ts'

describe('sqlite hybrid domain ports (leases/verifications/retention/artifacts)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codetask-hybrid-ports-'))
  const sqlitePath = join(dir, 'kernel.sqlite')
  const artifactsDir = join(dirname(sqlitePath), 'artifacts')
  const app = createApplication({ mode: 'sqlite', sqlitePath })

  after(() => {
    app.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lease tryAcquire conflict / re-acquire / release / clearStale', async () => {
    const ws = 'ws-1'
    assert.equal(
      await app.leases.tryAcquire({
        workspaceId: ws,
        holderId: 'holder-a',
        acquiredAtMs: 1000
      }),
      true
    )
    assert.equal(
      await app.leases.tryAcquire({
        workspaceId: ws,
        holderId: 'holder-b',
        acquiredAtMs: 2000
      }),
      false
    )
    assert.equal(
      await app.leases.tryAcquire({
        workspaceId: ws,
        holderId: 'holder-a',
        acquiredAtMs: 3000
      }),
      true
    )
    const got = await app.leases.get(ws)
    assert.equal(got?.holderId, 'holder-a')
    assert.equal(got?.acquiredAtMs, 3000)

    await app.leases.release(ws, 'holder-b')
    assert.ok(await app.leases.get(ws))
    await app.leases.release(ws, 'holder-a')
    assert.equal(await app.leases.get(ws), undefined)

    await app.leases.tryAcquire({
      workspaceId: 'ws-stale',
      holderId: 'h1',
      acquiredAtMs: 100
    })
    await app.leases.tryAcquire({
      workspaceId: 'ws-fresh',
      holderId: 'h2',
      acquiredAtMs: 9000
    })
    const cleared = await app.leases.clearStale(10_000, 1000)
    assert.equal(cleared, 1)
    assert.equal(await app.leases.get('ws-stale'), undefined)
    assert.ok(await app.leases.get('ws-fresh'))
  })

  it('verification save/get/listForJob/listForScope (job first)', async () => {
    const threadId = 'thread-v1'
    const jobId = 'job-v1'
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

    const pending: VerificationAttempt = {
      id: asVerificationAttemptId('va-1'),
      jobId,
      scope: 'slice',
      scopeId: 'slice-1',
      status: 'pending',
      executionGeneration: 1,
      result: null
    }
    await app.verifications.save(pending)
    assert.deepEqual(await app.verifications.get('va-1'), pending)

    const completed: VerificationAttempt = {
      ...pending,
      status: 'completed',
      result: {
        verdict: 'pass',
        summary: 'ok',
        evidenceRefs: ['e1'],
        findings: [{ code: 'c1', severity: 'info', message: 'fine' }]
      }
    }
    await app.verifications.save(completed)
    assert.deepEqual(await app.verifications.get('va-1'), completed)

    const other: VerificationAttempt = {
      id: asVerificationAttemptId('va-2'),
      jobId,
      scope: 'milestone',
      scopeId: 'm1',
      status: 'pending',
      executionGeneration: 1,
      result: null
    }
    await app.verifications.save(other)

    const forJob = await app.verifications.listForJob(jobId)
    assert.equal(forJob.length, 2)
    const forScope = await app.verifications.listForScope(jobId, 'slice', 'slice-1')
    assert.equal(forScope.length, 1)
    assert.deepEqual(forScope[0], completed)
  })

  it('retention save/get/list/markDeleted', async () => {
    const artifact: RetainedArtifact = {
      id: 'ret-1',
      kind: 'transient',
      expiresAtMs: 50_000,
      deletedAtMs: null
    }
    await app.retention.save(artifact)
    assert.deepEqual(await app.retention.get('ret-1'), artifact)

    await app.retention.markDeleted('ret-1', 60_000)
    const deleted = await app.retention.get('ret-1')
    assert.equal(deleted?.deletedAtMs, 60_000)

    const listed = await app.retention.list()
    assert.ok(listed.some((a) => a.id === 'ret-1' && a.deletedAtMs === 60_000))
  })

  it('artifact putMeta/getMeta + beginWrite commit roundtrip', async () => {
    await app.artifacts.putMeta({
      id: 'meta-1',
      kind: 'log',
      contentHash: 'abc',
      createdAtMs: 1,
      incomplete: false
    })
    const meta = await app.artifacts.getMeta('meta-1')
    assert.equal(meta?.id, 'meta-1')
    assert.equal(meta?.kind, 'log')
    assert.equal(meta?.contentHash, 'abc')
    assert.equal(meta?.incomplete, false)

    const handle = await app.artifacts.beginWrite('art-1', 'blob')
    await handle.writeChunk('hello ')
    await handle.writeChunk(Buffer.from('world'))
    const committed = await handle.commit({ contentHash: 'sha-art-1' })
    assert.equal(committed.incomplete, false)
    assert.equal(committed.contentHash, 'sha-art-1')

    const loaded = await app.artifacts.getMeta('art-1')
    assert.equal(loaded?.incomplete, false)
    assert.equal(loaded?.contentHash, 'sha-art-1')

    const filePath = join(artifactsDir, 'art-1')
    assert.ok(existsSync(filePath), `expected file at ${filePath}`)
    assert.equal(readFileSync(filePath, 'utf8'), 'hello world')
  })
})
