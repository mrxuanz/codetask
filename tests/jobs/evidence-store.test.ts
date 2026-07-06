import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { DEFAULT_RETENTION_SETTINGS } from '../../src/shared/contracts/retention'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../../src/server/db'
import {
  externalizeTaskEvidence,
  hydrateTaskEvidenceSync,
  slimTaskEvidence
} from '../../src/server/jobs/evidence/store'
import { seedMinimalJob } from '../helpers/seed-minimal-job'
import { shouldExternalizeEvidence } from '../../src/server/retention/lifecycle-helpers'

test('shouldExternalizeEvidence when payload exceeds inline limit', () => {
  const large = {
    status: 'completed' as const,
    summary: 'ok',
    changedFiles: [],
    evidence: ['x'.repeat(3000)],
    validation: { ran: true, outcome: 'passed' as const }
  }
  assert.equal(shouldExternalizeEvidence(large, 2048), true)
})

test('externalizeTaskEvidence always stores artifact and returns slim state', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-evidence-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    await seedMinimalJob(db, 'job-1', 'running')
    const settings = { ...DEFAULT_RETENTION_SETTINGS, artifactInlineMaxBytes: 1024 }
    const evidence = {
      status: 'completed' as const,
      summary: 'done',
      changedFiles: ['src/a.ts'],
      evidence: ['x'.repeat(3000)],
      validation: { ran: true, outcome: 'passed' as const }
    }

    const { evidence: slim, artifactId } = await externalizeTaskEvidence(
      dataDir,
      'job-1',
      'task-1',
      evidence,
      settings,
      db
    )

    assert.ok(artifactId)
    assert.deepEqual(slim.evidence, [])
    assert.equal(slim.evidenceLineCount, 1)

    const hydrated = hydrateTaskEvidenceSync(dataDir, slim, artifactId, db)
    assert.equal(hydrated?.evidence.length, 1)
    assert.equal(slimTaskEvidence(slim).evidence.length, 0)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('externalizeTaskEvidence stores small payloads in artifact registry too', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-evidence-small-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    await seedMinimalJob(db, 'job-1', 'running')
    const evidence = {
      status: 'completed' as const,
      summary: 'tiny',
      changedFiles: [],
      evidence: ['one line'],
      validation: { ran: true, outcome: 'passed' as const }
    }

    const { evidence: slim, artifactId } = await externalizeTaskEvidence(
      dataDir,
      'job-1',
      'task-2',
      evidence,
      DEFAULT_RETENTION_SETTINGS,
      db
    )

    assert.ok(artifactId)
    assert.deepEqual(slim.evidence, [])
    assert.equal(slim.evidenceLineCount, 1)

    const hydrated = hydrateTaskEvidenceSync(dataDir, slim, artifactId, db)
    assert.deepEqual(hydrated?.evidence, ['one line'])
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})
