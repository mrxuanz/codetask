import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { DEFAULT_RETENTION_SETTINGS } from '../../src/shared/contracts/retention'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../../src/server/db'
import {
  putJobArtifact,
  getJobArtifactPayload,
  deleteJobArtifact,
  deleteExpiredArtifacts,
  scheduleJobArtifactExpiry
} from '../../src/server/retention/artifacts'
import {
  syncJobCountersFromProgress,
  loadJobCountersIntoProgress,
  deleteJobCounters
} from '../../src/server/retention/counters'
import { summarizeEvidence } from '../../src/server/retention/lifecycle-helpers'
import { seedMinimalJob } from '../helpers/seed-minimal-job'
import type { TaskEvidenceDto } from '../../src/shared/contracts/evidence'
import { eq } from 'drizzle-orm'
import { jobArtifacts } from '../../src/server/db/schema'

test('putJobArtifact uses the configured threshold and hydrates file payloads', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-artifact-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    await seedMinimalJob(db, 'job-1', 'running')

    const evidence: TaskEvidenceDto = {
      status: 'completed',
      summary: 'done',
      changedFiles: ['a.ts'],
      evidence: Array.from({ length: 200 }, (_, i) => `line-${i}-${'x'.repeat(80)}`),
      validation: { ran: true, outcome: 'passed' }
    }

    const artifactId = await putJobArtifact({
      db,
      dataDir,
      jobId: 'job-1',
      taskId: 't1',
      kind: 'task_evidence',
      payload: evidence,
      expiresAt: null,
      settings: { ...DEFAULT_RETENTION_SETTINGS, artifactInlineMaxBytes: 1024 }
    })

    const loaded = await getJobArtifactPayload<TaskEvidenceDto>(db, dataDir, artifactId)
    assert.equal(loaded?.summary, 'done')
    assert.equal(loaded?.evidence.length, 200)
    const row = await db
      .select()
      .from(jobArtifacts)
      .where(eq(jobArtifacts.id, artifactId))
      .limit(1)
      .then((rows) => rows[0])
    assert.equal(row?.storage, 'file')
    assert.equal(row?.contentBlob, null)
    assert.ok(row?.contentPath && existsSync(join(dataDir, row.contentPath)))
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('putJobArtifact stores small compressed payloads as SQLite BLOB rather than base64 TEXT', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-artifact-inline-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    await seedMinimalJob(db, 'job-inline', 'running')
    const artifactId = await putJobArtifact({
      db,
      dataDir,
      jobId: 'job-inline',
      kind: 'verifier_bundle',
      payload: { verdict: 'pass' },
      settings: { ...DEFAULT_RETENTION_SETTINGS, artifactInlineMaxBytes: 1024 }
    })
    const row = await db
      .select()
      .from(jobArtifacts)
      .where(eq(jobArtifacts.id, artifactId))
      .limit(1)
      .then((rows) => rows[0])
    assert.equal(row?.storage, 'inline')
    assert.ok(Buffer.isBuffer(row?.contentBlob))
    assert.equal(row?.contentInline, null)
    assert.deepEqual(await getJobArtifactPayload(db, dataDir, artifactId), { verdict: 'pass' })
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('content-addressed files remain until their final metadata reference is deleted', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-artifact-shared-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    await seedMinimalJob(db, 'job-shared', 'running')
    const options = {
      db,
      dataDir,
      jobId: 'job-shared',
      kind: 'task_evidence' as const,
      payload: { repeated: 'x'.repeat(1024) },
      settings: { ...DEFAULT_RETENTION_SETTINGS, artifactInlineMaxBytes: 0 }
    }
    const first = await putJobArtifact({ ...options, taskId: 'task-1' })
    const second = await putJobArtifact({ ...options, taskId: 'task-2' })
    const row = db.select().from(jobArtifacts).where(eq(jobArtifacts.id, first)).limit(1).all()[0]
    assert.ok(row?.contentPath)
    const sharedPath = join(dataDir, row.contentPath)
    assert.equal(existsSync(sharedPath), true)

    await deleteJobArtifact({ db, dataDir, artifactId: first })
    assert.equal(existsSync(sharedPath), true)
    assert.deepEqual(await getJobArtifactPayload(db, dataDir, second), options.payload)

    await deleteJobArtifact({ db, dataDir, artifactId: second })
    assert.equal(existsSync(sharedPath), false)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('deleteExpiredArtifacts removes expired rows', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-expire-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    const now = Math.floor(Date.now() / 1000)
    await seedMinimalJob(db, 'job-2', 'completed')

    const artifactId = await putJobArtifact({
      db,
      dataDir,
      jobId: 'job-2',
      taskId: 't1',
      kind: 'task_evidence',
      payload: {
        status: 'failed',
        summary: 'x',
        changedFiles: [],
        evidence: [],
        validation: { ran: false, outcome: 'skipped' }
      },
      expiresAt: now - 10,
      settings: DEFAULT_RETENTION_SETTINGS
    })

    const result = await deleteExpiredArtifacts(db, dataDir)
    assert.ok(result.deleted >= 1)
    const gone = await getJobArtifactPayload(db, dataDir, artifactId)
    assert.equal(gone, null)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('job counters sync round-trip', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-counter-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    await seedMinimalJob(db, 'job-3', 'running')

    await syncJobCountersFromProgress(db, 'job-3', {
      phase: 'running',
      status: 'running',
      currentIndex: 0,
      total: 1,
      tasks: [],
      repairGenerations: { 'task-infra:t1': 2 }
    })

    const loaded = await loadJobCountersIntoProgress(db, 'job-3', {
      phase: 'running',
      status: 'running',
      currentIndex: 0,
      total: 1,
      tasks: []
    })
    assert.equal(loaded.repairGenerations?.['task-infra:t1'], 2)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('scheduleJobArtifactExpiry and deleteJobCounters support terminal compaction', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-terminal-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    const expiresAt = Math.floor(Date.now() / 1000) + 86_400
    await seedMinimalJob(db, 'job-4', 'completed')

    await syncJobCountersFromProgress(db, 'job-4', {
      phase: 'completed',
      status: 'completed',
      currentIndex: 0,
      total: 1,
      tasks: [],
      verificationAttempts: { 'slice:m1-s1': 2 }
    })

    const artifactId = await putJobArtifact({
      db,
      dataDir,
      jobId: 'job-4',
      taskId: 't1',
      kind: 'task_evidence',
      payload: {
        status: 'completed',
        summary: 'done',
        changedFiles: [],
        evidence: ['line'],
        validation: { ran: true, outcome: 'passed' }
      },
      expiresAt: null,
      settings: DEFAULT_RETENTION_SETTINGS
    })

    await scheduleJobArtifactExpiry(db, 'job-4', expiresAt)
    await deleteJobCounters(db, 'job-4')

    const artifact = await getJobArtifactPayload(db, dataDir, artifactId)
    assert.equal(artifact?.summary, 'done')

    const loaded = await loadJobCountersIntoProgress(db, 'job-4', {
      phase: 'completed',
      status: 'completed',
      currentIndex: 0,
      total: 1,
      tasks: []
    })
    assert.equal(loaded.verificationAttempts, undefined)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('summarizeEvidence prefers summary text', () => {
  const summary = summarizeEvidence({
    status: 'blocked',
    summary: '  blocked on tests  ',
    changedFiles: [],
    evidence: ['detail'],
    validation: { ran: false, outcome: 'skipped' }
  })
  assert.equal(summary, 'blocked on tests')
})
