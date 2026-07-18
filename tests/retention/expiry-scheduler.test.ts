import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AppContext } from '../../src/server/context'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../../src/server/db'
import { designPlanRevisions, jobArtifacts, messageArtifacts } from '../../src/server/db/schema'
import { putJobArtifact } from '../../src/server/retention/artifacts'
import { putDesignPlanRevisionInTx } from '../../src/server/retention/design-plan-artifacts'
import { ArtifactExpiryScheduler } from '../../src/server/retention/expiry-scheduler'
import { putMessageArtifact } from '../../src/server/retention/message-artifacts'
import { DEFAULT_RETENTION_SETTINGS } from '../../src/shared/contracts/retention'
import { seedMinimalJob } from '../helpers/seed-minimal-job'

test('expiry scheduler startup catch-up deletes overdue Job, Message, and Design artifacts', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-expiry-scheduler-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const db = createIsolatedTestDatabase(dataDir)
  t.after(() => closeIsolatedTestDatabase(db))
  await seedMinimalJob(db, 'job-expiry-scheduler', 'running')
  const expiresAt = 999

  const jobArtifactId = await putJobArtifact({
    db,
    dataDir,
    jobId: 'job-expiry-scheduler',
    kind: 'verifier_bundle',
    payload: { large: 'x'.repeat(5000) },
    expiresAt,
    settings: { ...DEFAULT_RETENTION_SETTINGS, artifactInlineMaxBytes: 10 }
  })
  const jobRow = await db
    .select()
    .from(jobArtifacts)
    .then((rows) => rows.find((row) => row.id === jobArtifactId))
  assert.ok(jobRow?.contentPath && existsSync(join(dataDir, jobRow.contentPath)))

  await putMessageArtifact({
    db,
    dataDir,
    messageId: 'draft-1',
    payload: { large: 'y'.repeat(5000) },
    expiresAt,
    settings: { ...DEFAULT_RETENTION_SETTINGS, messagePayloadInlineMaxBytes: 10 }
  })
  putDesignPlanRevisionInTx(db, {
    jobId: 'job-expiry-scheduler',
    planRevision: 1,
    plan: { milestones: [], tasks: [] },
    expiresAt
  })

  const scheduler = new ArtifactExpiryScheduler(
    { db, dataDir } as unknown as AppContext,
    () => 1_000_000
  )
  const result = await scheduler.runDueNow()
  assert.equal(result.deletedRows, 3)
  assert.equal((await db.select().from(jobArtifacts)).length, 0)
  assert.equal((await db.select().from(messageArtifacts)).length, 0)
  assert.equal((await db.select().from(designPlanRevisions)).length, 0)
  assert.equal(jobRow?.contentPath ? existsSync(join(dataDir, jobRow.contentPath)) : true, false)
})
