import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { bootstrapRuntime, resetAppContextForTests } from '../../../src/server/bootstrap'
import { createLegacyApplicationRuntime } from '../../../src/server/application/legacy-application-runtime'
import { readSchemaGeneration } from '../../../src/server/application/cutover-state'
import { getDb } from '../../../src/server/db'
import { threadJobs } from '../../../src/server/db/schema'
import { resetJobReconcileForTests } from '../../../src/server/legacy-control-plane/reconcile'
import { beginDraining, endDraining } from '../../../src/server/legacy-control-plane/shutdown-state'
import { resetStartupWorkloadGateForTests } from '../../../src/server/legacy-control-plane/workload-slot'
import { seedJobGraph } from '../../helpers/seed-job-graph'

test('startup recovery does not wait on its own workload gate for an orphan running job', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-startup-running-job-'))
  await resetAppContextForTests()

  try {
    const ctx = bootstrapRuntime({ dataDir })
    await seedJobGraph(getDb(), {
      jobId: 'job-startup-recovery',
      username: 'user',
      threadId: 'thread-startup-recovery',
      draftMessageId: 'draft-startup-recovery',
      status: 'running',
      workspacePath: dataDir,
      executionLeaseOwner: 'dead-process-old-boot',
      executionLeaseExpiresAt: Math.floor(Date.now() / 1000) + 600
    })

    // Build the real Legacy startup coordinator over a database that already contains an orphan.
    // Draining suppresses real execution but does not bypass advanceExecutionQueue's initial gate.
    resetJobReconcileForTests()
    resetStartupWorkloadGateForTests()
    beginDraining()
    const runtime = createLegacyApplicationRuntime(ctx, readSchemaGeneration(ctx.db))
    ctx.applicationRuntime = runtime

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        runtime.startup.ensureReady(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('startup recovery remained gate-blocked')),
            2_000
          )
        })
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    assert.equal(runtime.startup.getPhase(), 'ready')
    const recovered = getDb()
      .select({ status: threadJobs.status, leaseOwner: threadJobs.executionLeaseOwner })
      .from(threadJobs)
      .where(eq(threadJobs.id, 'job-startup-recovery'))
      .get()
    assert.equal(recovered?.status, 'running')
    assert.equal(recovered?.leaseOwner, null)
  } finally {
    endDraining()
    await resetAppContextForTests()
    resetJobReconcileForTests()
    resetStartupWorkloadGateForTests()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
