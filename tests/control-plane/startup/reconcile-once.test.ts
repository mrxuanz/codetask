import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { bootstrapRuntime, resetAppContextForTests } from '../../../src/server/bootstrap'
import { setCutoverMarkerForTests } from '../../../src/server/application/cutover-state'
import { closeDatabaseForTests } from '../../../src/server/db'
import {
  reconcileOrphanRunningJobsOnStartupOnce,
  resetJobReconcileForTests
} from '../../../src/server/legacy-control-plane/reconcile'

describe('startup: reconcile Once retry semantics', () => {
  it('retries reconcile Once after first failure instead of skipping', async () => {
    resetJobReconcileForTests()
    closeDatabaseForTests()

    await assert.rejects(
      () => reconcileOrphanRunningJobsOnStartupOnce(),
      /Database not initialized/
    )
    await assert.rejects(
      () => reconcileOrphanRunningJobsOnStartupOnce(),
      /Database not initialized/
    )

    const dataDir = mkdtempSync(join(tmpdir(), 'cp-reconcile-once-'))
    await resetAppContextForTests()
    setCutoverMarkerForTests('copied')
    resetJobReconcileForTests()

    try {
      bootstrapRuntime({ dataDir })
      await reconcileOrphanRunningJobsOnStartupOnce()
      await reconcileOrphanRunningJobsOnStartupOnce()
    } finally {
      await resetAppContextForTests()
      setCutoverMarkerForTests(null)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
