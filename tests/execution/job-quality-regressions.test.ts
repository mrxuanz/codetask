import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import { migration043DesignModuleTables } from '../../packages/database/src/migrations/index.ts'
import { migration045ExecutionModuleTables } from '../../packages/database/src/migrations/execution.ts'
import { ExecutionOutbox } from '../../packages/server-core/src/modules/execution/events/execution-outbox.ts'
import { DeleteJobService } from '../../packages/server-core/src/modules/execution/job/application/delete-job.ts'
import { JobRepository } from '../../packages/server-core/src/modules/execution/job/infrastructure/job-repository.ts'
import { QueueRepository } from '../../packages/server-core/src/modules/execution/queue/infrastructure/queue-repository.ts'
import { createStartupReconcileService } from '../../packages/server-core/src/modules/execution/recovery/application/startup.ts'
import { ExecutionConflictError } from '../../packages/server-core/src/modules/execution/shared.ts'
import { RuntimeHandleRegistry } from '../../packages/server-core/src/modules/execution/pool/infrastructure/runtime-handle-registry.ts'
import { ScriptedAgentRuntime } from '../../packages/server-core/src/modules/execution/pool/infrastructure/scripted-agent-runtime.ts'
import { createAcceptWorkResultService } from '../../packages/server-core/src/modules/execution/work/application/accept-work-result.ts'
import { createExecuteWorkService } from '../../packages/server-core/src/modules/execution/work/application/execute-work.ts'
import { WorkRepository } from '../../packages/server-core/src/modules/execution/work/infrastructure/work-repository.ts'

function setup(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migration043DesignModuleTables.up(db)
  migration045ExecutionModuleTables.up(db)
  return db
}

function insertJob(
  db: Database.Database,
  input: {
    id: string
    actorId?: string
    state?: string
    revision?: number
    controlIntent?: string
    currentRunId?: string | null
  }
): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO jobs (
      id, submission_id, submission_hash, idempotency_key, actor_id, project_id,
      source_draft_id, source_planning_session_id, title, summary,
      workspace_root, canonical_workspace_root, state, state_revision, control_intent,
      execution_generation, current_run_id, queued_at, created_at, updated_at
    ) VALUES (?, ?, 'hash', ?, ?, 'project', 'draft', 'planning', ?, '',
      ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
  ).run(
    input.id,
    `submission-${input.id}`,
    `submit-idem-${input.id}`,
    input.actorId ?? 'alice',
    input.id,
    `/tmp/${input.id}`,
    `/tmp/${input.id}`,
    input.state ?? 'queued',
    input.revision ?? 0,
    input.controlIntent ?? 'none',
    input.currentRunId ?? null,
    now,
    now,
    now
  )
}

function insertWork(
  db: Database.Database,
  input: { jobId: string; id: string; state: string; revision?: number }
): void {
  const now = Date.now()
  db.prepare(
    `INSERT INTO job_work_items (
      id, job_id, generation, source_task_id, milestone_id, slice_id, kind, task_kind,
      sort_order, title, description, context_markdown, ability_code, provider_code,
      success_criteria, reference_reason, required_inputs_json, can_run_in_parallel,
      state, state_revision, created_at, updated_at
    ) VALUES (?, ?, 0, ?, 'milestone', 'slice', 'task', 'implementation',
      0, ?, '', '', 'general', 'opencode', '', '', '[]', 0, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.jobId,
    `source-${input.id}`,
    input.id,
    input.state,
    input.revision ?? 0,
    now,
    now
  )
}

function insertQueue(db: Database.Database, jobId: string, status = 'queued', sequence = 1): void {
  db.prepare(
    `INSERT INTO execution_queue_entries (
      job_id, generation, status, priority, sequence, enqueued_at, claimed_at
    ) VALUES (?, 0, ?, 0, ?, ?, ?)`
  ).run(jobId, status, sequence, Date.now(), Date.now())
}

describe('Job release-quality regressions', () => {
  it('filters the execution queue by actor', () => {
    const db = setup()
    insertJob(db, { id: 'alice-job', actorId: 'alice' })
    insertJob(db, { id: 'bob-job', actorId: 'bob' })
    insertQueue(db, 'bob-job', 'queued', 1)
    insertQueue(db, 'alice-job', 'queued', 2)

    const visible = new QueueRepository(db).listQueued('alice')
    assert.deepEqual(
      visible.map((entry) => entry.jobId),
      ['alice-job']
    )
    assert.equal(visible[0]?.position, 2)
    db.close()
  })

  it('reports stale state revisions as execution conflicts', () => {
    const db = setup()
    insertJob(db, { id: 'revision-job', revision: 3 })
    const jobs = new JobRepository(db)
    assert.throws(
      () =>
        jobs.casUpdateState({
          jobId: 'revision-job',
          expectedRevision: 2,
          next: { state: 'cancelled', updatedAt: Date.now() }
        }),
      ExecutionConflictError
    )
    db.close()
  })

  it('deletes a Job atomically without leaving execution-owned orphan rows', () => {
    const db = setup()
    insertJob(db, { id: 'delete-job', state: 'succeeded', revision: 7 })
    insertWork(db, { jobId: 'delete-job', id: 'delete-work', state: 'succeeded' })
    insertQueue(db, 'delete-job', 'removed')
    db.prepare(
      `INSERT INTO job_slice_dependencies VALUES ('delete-job', 0, 'slice', 'dependency')`
    ).run()
    db.prepare(
      `INSERT INTO job_work_dependencies VALUES (
        'delete-job', 0, 'delete-work', 'dependency-work', 'planner'
      )`
    ).run()
    db.prepare(
      `INSERT INTO job_work_references VALUES ('delete-job', 0, 'delete-work', 'reference')`
    ).run()
    db.prepare(
      `INSERT INTO repair_generations (
        job_id, generation, scope_type, scope_id, generation_number, created_at
      ) VALUES ('delete-job', 0, 'slice', 'slice', 1, ?)`
    ).run(Date.now())
    db.prepare(
      `INSERT INTO workspace_leases (
        id, canonical_workspace_root, owner_type, owner_id, status, lease_owner,
        lease_expires_at, created_at, released_at
      ) VALUES ('old-lease', '/tmp/delete-job', 'job-run', 'delete-job', 'released',
        'test', ?, ?, ?)`
    ).run(Date.now(), Date.now(), Date.now())
    db.prepare(
      `INSERT INTO execution_outbox (
        id, job_id, event_type, payload_json, created_at, attempts
      ) VALUES ('old-outbox', 'delete-job', 'job.changed', '{}', ?, 0)`
    ).run(Date.now())
    db.prepare(
      `INSERT INTO job_command_receipts (
        actor_id, idempotency_key, job_id, command, request_hash, response_json, created_at
      ) VALUES ('alice', 'old-command', 'delete-job', 'pause', 'hash', '{}', ?)`
    ).run(Date.now())

    const jobs = new JobRepository(db)
    const service = new DeleteJobService(db, jobs, new ExecutionOutbox(db))
    const body = { expectedRevision: 7, idempotencyKey: 'delete-command' }
    const result = service.delete({ userId: 'alice', sessionId: 'session' }, 'delete-job', body)
    assert.equal(result.accepted, true)

    for (const table of [
      'jobs',
      'job_slice_dependencies',
      'job_work_dependencies',
      'job_work_references',
      'repair_generations',
      'execution_queue_entries'
    ]) {
      const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
      assert.equal(count.count, 0, `${table} should not retain deleted Job rows`)
    }
    const leases = db
      .prepare(`SELECT COUNT(*) AS count FROM workspace_leases WHERE owner_id = 'delete-job'`)
      .get() as { count: number }
    assert.equal(leases.count, 0)
    const outbox = db
      .prepare(`SELECT event_type, payload_json FROM execution_outbox`)
      .all() as Array<{ event_type: string; payload_json: string }>
    assert.equal(outbox.length, 1)
    assert.equal(outbox[0]?.event_type, 'job.deleted')
    assert.equal(JSON.parse(outbox[0]!.payload_json).actorId, 'alice')
    const receipts = db
      .prepare(`SELECT idempotency_key FROM job_command_receipts ORDER BY idempotency_key`)
      .all() as Array<{ idempotency_key: string }>
    assert.deepEqual(
      receipts.map((receipt) => receipt.idempotency_key),
      ['delete-command', 'old-command']
    )

    assert.deepEqual(
      service.delete({ userId: 'alice', sessionId: 'session' }, 'delete-job', body),
      result
    )
    assert.throws(
      () => service.delete({ userId: 'alice', sessionId: 'session' }, 'another-job', body),
      ExecutionConflictError
    )
    db.close()
  })

  it('settles pausing/cancelling states and resets interrupted work on startup', () => {
    const db = setup()
    insertJob(db, {
      id: 'pausing-job',
      state: 'pausing',
      revision: 4,
      controlIntent: 'pause',
      currentRunId: 'run-pausing'
    })
    insertWork(db, { jobId: 'pausing-job', id: 'pausing-work', state: 'running', revision: 2 })
    insertQueue(db, 'pausing-job', 'claimed')
    db.prepare(
      `INSERT INTO work_attempts (
        id, job_id, work_id, generation, run_id, attempt_number, idempotency_key,
        status, started_at
      ) VALUES ('attempt-pausing', 'pausing-job', 'pausing-work', 0, 'run-pausing', 1,
        'attempt-idem-pausing', 'starting', ?)`
    ).run(Date.now())

    insertJob(db, {
      id: 'cancelling-job',
      state: 'cancelling',
      revision: 8,
      controlIntent: 'cancel',
      currentRunId: 'run-cancelling'
    })
    insertWork(db, {
      jobId: 'cancelling-job',
      id: 'cancelling-work',
      state: 'leased',
      revision: 1
    })
    insertQueue(db, 'cancelling-job', 'claimed')

    createStartupReconcileService({ db }).run()

    const pausing = new JobRepository(db).requireById('pausing-job')
    assert.equal(pausing.state, 'paused')
    assert.equal(pausing.stateRevision, 5)
    assert.equal(pausing.controlIntent, 'none')
    assert.equal(pausing.currentRunId, null)
    assert.equal(pausing.recoveryReason, 'uncertain_provider_outcome')
    assert.deepEqual(
      db
        .prepare(`SELECT state, state_revision FROM job_work_items WHERE id = 'pausing-work'`)
        .get(),
      { state: 'pending', state_revision: 3 }
    )
    assert.equal(
      (
        db.prepare(`SELECT status FROM work_attempts WHERE id = 'attempt-pausing'`).get() as {
          status: string
        }
      ).status,
      'interrupted'
    )

    const cancelling = new JobRepository(db).requireById('cancelling-job')
    assert.equal(cancelling.state, 'cancelled')
    assert.equal(cancelling.stateRevision, 9)
    assert.equal(cancelling.controlIntent, 'none')
    assert.equal(cancelling.currentRunId, null)
    assert.equal(
      (
        db.prepare(`SELECT state FROM job_work_items WHERE id = 'cancelling-work'`).get() as {
          state: string
        }
      ).state,
      'cancelled'
    )
    const queueStates = db
      .prepare(`SELECT status FROM execution_queue_entries ORDER BY job_id`)
      .all() as Array<{ status: string }>
    assert.ok(queueStates.every((entry) => entry.status === 'removed'))
    db.close()
  })

  it('aborts the post-completion evidence wait and returns work to pending', async () => {
    const db = setup()
    insertJob(db, { id: 'evidence-job', state: 'running', currentRunId: 'evidence-run' })
    insertWork(db, { jobId: 'evidence-job', id: 'evidence-work', state: 'pending' })
    db.prepare(
      `INSERT INTO job_snapshots (
        job_id, draft_snapshot_json, execution_profile_json,
        execution_settings_snapshot_json, reference_manifest_json,
        execution_tree_json, settings_hash, content_hash, created_at
      ) VALUES (?, '{}', '{}', ?, ?, '{}', 'settings', 'content', ?)`
    ).run(
      'evidence-job',
      JSON.stringify({ settingsHash: 'settings', capturedAt: '', payload: {} }),
      JSON.stringify({ references: [] }),
      Date.now()
    )

    const work = new WorkRepository(db)
    const outbox = new ExecutionOutbox(db)
    const handles = new RuntimeHandleRegistry()
    const execute = createExecuteWorkService({
      db,
      work,
      outbox,
      handles,
      evidenceGraceMs: 30_000,
      agentRuntime: new ScriptedAgentRuntime(async () => [
        { type: 'completed' as const, reason: 'completed-without-evidence' }
      ]),
      acceptResult: createAcceptWorkResultService({ db, work, outbox })
    })

    const dispatch = execute.dispatch({
      jobId: 'evidence-job',
      workId: 'evidence-work',
      runId: 'evidence-run',
      workspaceRoot: '/tmp/evidence-job'
    })
    for (
      let i = 0;
      i < 20 && work.requireWork('evidence-job', 'evidence-work').state !== 'running';
      i++
    ) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    handles.abort('evidence-run', 'test-pause')
    await dispatch

    assert.equal(work.requireWork('evidence-job', 'evidence-work').state, 'pending')
    assert.equal(
      (
        db.prepare(`SELECT status FROM work_attempts WHERE work_id = 'evidence-work'`).get() as {
          status: string
        }
      ).status,
      'interrupted'
    )
    db.close()
  })
})
