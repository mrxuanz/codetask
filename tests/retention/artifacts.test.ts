import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { DEFAULT_RETENTION_SETTINGS } from '../../src/shared/contracts/retention'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../../src/server/db'
import {
  putJobArtifact,
  getJobArtifactPayload,
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

test('putJobArtifact stores payloads inline and hydrates round-trip', async () => {
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
