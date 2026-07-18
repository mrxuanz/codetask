import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { runMigrations } from '../../../src/server/db/migrations/runner'
import { allMigrations } from '../../../src/server/db/migrations/index'
import { controlPlaneSchema } from '../../../src/server/infra/sqlite/control-plane/schema'
import { createControlPlaneTransaction } from '../../../src/server/infra/sqlite/control-plane/sqlite-control-plane-unit-of-work'
import { JobCommandServiceImpl } from '../../../src/server/application/job-command-service'
import {
  createExecutorDependencies,
  type ExecutorRuntimePorts
} from '../../../src/server/application/executor-adapter'
import { executeRun } from '../../../src/server/application/executor-loop'
import type { TaskExecutionProvider } from '../../../src/server/application/ports/task-execution-provider'
import { RuntimeSupervisor } from '../../../src/server/application/runtime-supervisor'
import { TaskExecutionRegistry } from '../../../src/server/application/task-execution-registry'
import type { RuntimeController } from '../../../src/server/application/ports/runtime-controller'
import { seedOwnedThreadJob } from '../fixtures/seed-owned-thread-job'

function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db, allMigrations)
  return db
}

function seedJobAndTask(db: Database.Database): void {
  const now = Date.now()
  seedOwnedThreadJob(db, { jobId: 'job-1', username: 'u1', status: 'running' })
  db.prepare(
    `INSERT INTO control_jobs (
      id, thread_id, project_id, draft_message_id, state, state_revision,
      control_intent, resume_target, execution_generation, active_run_id, title, requirements_summary,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, 'none', NULL, 0, 'run-1', 'Test', '', ?, ?)`
  ).run('job-1', 'thread-job-1', 'project-job-1', 'draft-job-1', 'execution_running', 1, now, now)
  db.prepare(
    `INSERT INTO control_job_runs (
      id, job_id, kind, state, attempt_no, fence_token, execution_generation, started_at_ms
    ) VALUES ('run-1', 'job-1', 'execution', 'active', 1, 'fence-1', 0, ?)`
  ).run(now)
  db.prepare(
    `INSERT INTO control_job_tasks (
      job_id, execution_generation, task_id, source_plan_revision, state, sort_order,
      title, created_at_ms, updated_at_ms
    ) VALUES ('job-1', 0, 'task-1', 1, 'queued', 0, 'Task 1', ?, ?)`
  ).run(now, now)
}

function buildRuntimeStub(rawDb: Database.Database): ExecutorRuntimePorts {
  const drizzleDb = drizzle(rawDb, { schema: controlPlaneSchema })
  const controlPlane = createControlPlaneTransaction(drizzleDb)
  const registry = new TaskExecutionRegistry()
  const runtimeController: RuntimeController = {
    notifyPauseRequested() {
      void 0
    },
    async closeThenRelease() {
      void 0
    }
  }
  const commandService = new JobCommandServiceImpl({
    unitOfWork: controlPlane,
    clock: { nowMs: () => 1_700_000_000_000 },
    idGenerator: { generate: () => randomUUID() },
    logger: {
      debug() {
        void 0
      },
      info() {
        void 0
      },
      warn() {
        void 0
      },
      error() {
        void 0
      }
    },
    runtimeController
  })

  return {
    jobRepository: controlPlane.jobs,
    taskRepository: controlPlane.tasks,
    unitOfWork: controlPlane,
    commandService,
    runtimeSupervisor: new RuntimeSupervisor(
      {
        debug() {
          void 0
        },
        info() {
          void 0
        },
        warn() {
          void 0
        },
        error() {
          void 0
        }
      },
      registry
    )
  }
}

describe('executor-no-synthetic (CR5)', () => {
  it('production adapter source does not synthesize completed task results', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/server/application/executor-adapter.ts'),
      'utf8'
    )
    assert.doesNotMatch(source, /status:\s*'completed'/)
    assert.doesNotMatch(source, /evidence:\s*\[/)
    assert.doesNotMatch(source, /Completed task:/)
  })

  let rawDb: Database.Database

  beforeEach(() => {
    rawDb = createTestDb()
    seedJobAndTask(rawDb)
  })

  it('does not mark task success when provider output fails validation', async () => {
    const provider: TaskExecutionProvider = {
      async executeTask() {
        return { kind: 'result', raw: { status: 'completed', summary: 'x' } }
      }
    }
    const runtime = buildRuntimeStub(rawDb)
    const abort = new AbortController()
    const context = {
      jobId: 'job-1',
      runId: 'run-1',
      fenceToken: 'fence-1',
      executionGeneration: 0,
      expectedRevision: 1,
      workIdentity: '',
      abortSignal: abort.signal
    }
    const deps = createExecutorDependencies({
      runtime,
      taskExecutionProvider: provider,
      clock: { nowMs: () => 1_700_000_000_000 },
      idGenerator: { generate: () => randomUUID() }
    })
    await executeRun(context, deps, abort.signal)

    const task = rawDb
      .prepare(`SELECT state FROM control_job_tasks WHERE task_id = 'task-1'`)
      .get() as { state: string }
    assert.notEqual(task.state, 'completed')
    const job = rawDb
      .prepare(`SELECT state FROM control_jobs WHERE id = 'job-1'`)
      .get() as { state: string }
    assert.equal(job.state, 'failed')
  })

  it('checkpoints only provider-supplied results through the injected port', async () => {
    const result = {
      status: 'completed' as const,
      summary: 'provider delivered',
      changedFiles: ['src/a.ts'],
      evidence: ['real provider evidence'],
      validation: { ran: true, outcome: 'passed' as const },
      blockers: [],
      blockerKind: null
    }
    const provider: TaskExecutionProvider = {
      async executeTask() {
        return { kind: 'result', raw: result }
      }
    }
    const runtime = buildRuntimeStub(rawDb)
    const abort = new AbortController()
    const context = {
      jobId: 'job-1',
      runId: 'run-1',
      fenceToken: 'fence-1',
      executionGeneration: 0,
      expectedRevision: 1,
      workIdentity: '',
      abortSignal: abort.signal
    }
    const deps = createExecutorDependencies({
      runtime,
      taskExecutionProvider: provider,
      clock: { nowMs: () => 1_700_000_000_000 },
      idGenerator: { generate: () => randomUUID() }
    })
    await executeRun(context, deps, abort.signal)

    const task = rawDb
      .prepare(`SELECT state FROM control_job_tasks WHERE task_id = 'task-1'`)
      .get() as { state: string }
    assert.equal(task.state, 'completed')
    const attempt = rawDb
      .prepare(`SELECT result_hash, evidence_blob_hash FROM control_task_attempts WHERE task_id = 'task-1'`)
      .get() as { result_hash: string; evidence_blob_hash: string }
    assert.ok(attempt.result_hash)
    assert.ok(attempt.evidence_blob_hash)
  })
})
