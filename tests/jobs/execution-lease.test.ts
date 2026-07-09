import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import { bootstrapRuntime, resetAppContextForTests, getAppContext } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import { threadJobs } from '../../src/server/db/schema'
import {
  acquireExecutionLease,
  clearStaleExecutionLeaseIfNeeded,
  executionLeaseOwner,
  isStaleExecutionLeaseOwner
} from '../../src/server/jobs/repository'

const USERNAME = 'lease-user'
const JOB_ID = 'job-lease-test'

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

describe('execution lease stale recovery', () => {
  let dataDir: string

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'codetask-exec-lease-'))
    await resetAppContextForTests()
    bootstrapRuntime({ dataDir })

    const now = nowSec()
    const bootId = getAppContext().bootId
    await getDb()
      .insert(threadJobs)
      .values({
        id: JOB_ID,
        username: USERNAME,
        threadId: 'thread-lease',
        title: 'Lease test job',
        status: 'running',
        executionLeaseOwner: `999999-${bootId}-old`,
        executionLeaseExpiresAt: now + 3600,
        createdAt: now,
        updatedAt: now
      })
  })

  after(async () => {
    await resetAppContextForTests()
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        /* best-effort */
      }
    }
  })

  it('detects stale bootId lease owners', () => {
    const currentBootId = getAppContext().bootId
    assert.equal(isStaleExecutionLeaseOwner(`999999-${currentBootId}-old`), true)
    assert.equal(isStaleExecutionLeaseOwner(executionLeaseOwner()), false)
    assert.equal(isStaleExecutionLeaseOwner(null), false)
    assert.equal(isStaleExecutionLeaseOwner('pid-999999'), false)
  })

  it('rejects legacy pid-only lease as not stale', () => {
    const currentBootId = getAppContext().bootId
    assert.equal(isStaleExecutionLeaseOwner(`12345-${currentBootId}`), false)
  })

  it('clears stale lease left by a dead process', () => {
    assert.equal(clearStaleExecutionLeaseIfNeeded(JOB_ID), true)
    const row = getDb()
      .select({
        owner: threadJobs.executionLeaseOwner,
        expires: threadJobs.executionLeaseExpiresAt
      })
      .from(threadJobs)
      .where(eq(threadJobs.id, JOB_ID))
      .limit(1)
      .all()[0]
    assert.equal(row?.owner, null)
    assert.equal(row?.expires, null)
  })

  it('acquires lease after stale owner was cleared', () => {
    assert.equal(acquireExecutionLease(USERNAME, JOB_ID), true)
    const row = getDb()
      .select({ owner: threadJobs.executionLeaseOwner })
      .from(threadJobs)
      .where(eq(threadJobs.id, JOB_ID))
      .limit(1)
      .all()[0]
    assert.equal(row?.owner, executionLeaseOwner())
  })
})
