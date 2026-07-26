/**
 * R4 soak stub runner — stub only, not production soak.
 *
 * Creates a temp sqlite application, runs N job create/save/get cycles,
 * then asserts process heap and DB file size stay under loose ceilings.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteDomainJobRepository } from '../../src/server/adapters/sqlite/index.ts'
import { createApplication } from '../../src/server/composition/index.ts'
import {
  asProjectId,
  asThreadId,
  asUserId,
  createThread
} from '../../src/server/core/domain/conversation/index.ts'
import { createJob } from '../../src/server/core/domain/jobs/index.ts'

const ITERATIONS = 32
/** Loose absurdity ceiling — stub only; not a production soak bound. */
const MAX_HEAP_USED_BYTES = 512 * 1024 * 1024
/** Temp sqlite with ~32 jobs should stay tiny. */
const MAX_DB_BYTES = 8 * 1024 * 1024

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'codetask-soak-stub-'))
  const sqlitePath = join(dir, 'kernel.sqlite')
  const app = createApplication({ mode: 'sqlite', sqlitePath })

  try {
    const threadId = 'soak-thread-1'
    await app.threads.save(
      createThread({
        id: asThreadId(threadId),
        projectId: asProjectId('soak-project-1'),
        ownerUserId: asUserId('soak-user-1')
      })
    )

    const jobs = app.jobs as SqliteDomainJobRepository

    for (let i = 0; i < ITERATIONS; i += 1) {
      const jobId = `soak-job-${i}`
      jobs.bindThread(jobId, threadId)
      const created = createJob({
        id: jobId,
        status: 'queued',
        planRevision: 1,
        executionGeneration: 1,
        stateRevision: 0
      })
      await app.jobs.save(created)
      const got = await app.jobs.get(jobId)
      assert.ok(got, `job ${jobId} missing after save`)
      assert.equal(got.status, 'queued')
      assert.equal(got.stateRevision, 0)

      // Light status bump to exercise save/get again.
      const bumped = createJob({
        id: jobId,
        status: 'running',
        planRevision: 1,
        executionGeneration: 1,
        stateRevision: 1
      })
      await app.jobs.save(bumped)
      const again = await app.jobs.get(jobId)
      assert.equal(again?.status, 'running')
      assert.equal(again?.stateRevision, 1)
    }

    // Optional GC when exposed (node --expose-gc); stub does not require it.
    const maybeGc = (globalThis as { gc?: () => void }).gc
    if (typeof maybeGc === 'function') {
      maybeGc()
    }

    const heapUsed = process.memoryUsage().heapUsed
    assert.ok(
      heapUsed < MAX_HEAP_USED_BYTES,
      `heapUsed ${heapUsed} exceeded stub ceiling ${MAX_HEAP_USED_BYTES}`
    )

    const dbBytes = statSync(sqlitePath).size
    assert.ok(
      dbBytes < MAX_DB_BYTES,
      `sqlite size ${dbBytes} exceeded stub ceiling ${MAX_DB_BYTES}`
    )

    console.log(
      JSON.stringify(
        {
          ok: true,
          stub: true,
          note: 'soak stub only — not production soak / §17.4 full bounds',
          iterations: ITERATIONS,
          heapUsed,
          heapUsedMb: Number((heapUsed / (1024 * 1024)).toFixed(2)),
          maxHeapUsedMb: MAX_HEAP_USED_BYTES / (1024 * 1024),
          sqlitePath,
          dbBytes,
          dbKb: Number((dbBytes / 1024).toFixed(2)),
          maxDbMb: MAX_DB_BYTES / (1024 * 1024)
        },
        null,
        2
      )
    )
  } finally {
    app.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
