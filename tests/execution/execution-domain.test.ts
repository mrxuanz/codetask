import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { AgentRole, AgentTurnEvent } from '@codetask/agent-runtime'
import type { JobSubmission } from '@codetask/contracts'
import { allowedJobActions } from '../../packages/server-core/src/modules/execution/job/domain/job-actions.ts'
import {
  hashSubmission,
  JobSubmissionDedup
} from '../../packages/server-core/src/modules/execution/job/infrastructure/job-submission-dedup.ts'
import {
  composeExecutionModule,
  ScriptedAgentRuntime
} from '../../packages/server-core/src/modules/execution/index.ts'
import { migration043DesignModuleTables } from '../../packages/database/src/migrations/index.ts'
import { migration045ExecutionModuleTables } from '../../packages/database/src/migrations/execution.ts'
import {
  ExecutionConflictError,
  ExecutionValidationError
} from '../../packages/server-core/src/modules/execution/shared.ts'

function minimalSubmission(overrides: Partial<JobSubmission> = {}): JobSubmission {
  const now = new Date().toISOString()
  return {
    submissionId: 'sub_exec_test_1',
    idempotencyKey: 'idem_exec_test_1',
    actorId: 'alice',
    projectId: 'proj-1',
    title: 'Execution module smoke',
    summary: 'One-task job',
    workspaceRoot: '/tmp/codetask-exec-test',
    source: { draftId: 'draft-1', planningSessionId: 'plan-1' },
    draftSnapshot: {
      draftId: 'draft-1',
      actorId: 'alice',
      projectId: 'proj-1',
      title: 'Execution module smoke',
      summary: 'One-task job',
      userFlow: '',
      techStack: '',
      nfr: [],
      acceptance: [],
      verification: [],
      outOfScope: [],
      assumptions: [],
      requirementsMarkdown: '# Req',
      requirementsStatus: 'confirmed',
      lockedSections: {},
      executionProfile: {
        plannerCoreCode: 'opencode',
        sliceVerifierCoreCode: 'opencode',
        milestoneVerifierCoreCode: 'opencode'
      },
      capturedAt: now
    },
    referenceManifest: {
      snapshotId: 'snap-1',
      draftId: 'draft-1',
      draftLockRevision: 1,
      contentHash: 'hash-1',
      references: [],
      createdAt: now
    },
    executionProfile: {
      plannerCoreCode: 'opencode',
      sliceVerifierCoreCode: 'opencode',
      milestoneVerifierCoreCode: 'opencode'
    },
    executionSettings: {
      settingsHash: 'settings-1',
      capturedAt: now,
      payload: {}
    },
    executionTree: {
      treeId: 'tree-1',
      planningSessionId: 'plan-1',
      revision: 1,
      milestones: [
        {
          id: 'ms-1',
          title: 'Milestone',
          description: 'Do one thing',
          successCriteria: 'Done',
          confirmed: true,
          slices: [
            {
              id: 'sl-1',
              milestoneId: 'ms-1',
              title: 'Slice',
              description: 'Slice work',
              successCriteria: 'Slice done',
              confirmed: true,
              tasks: [
                {
                  id: 'task-1',
                  sliceId: 'sl-1',
                  title: 'Task',
                  description: 'Implement',
                  taskKind: 'implementation',
                  abilityCode: 'general',
                  coreCode: 'opencode',
                  contextMarkdown: 'context',
                  successCriteria: 'Task done',
                  referenceIds: [],
                  dependsOnTaskIds: [],
                  canRunInParallel: false,
                  confirmed: true
                }
              ]
            }
          ]
        }
      ]
    },
    createdAt: now,
    ...overrides
  }
}

function cycleSubmission(): JobSubmission {
  const base = minimalSubmission({
    submissionId: 'sub_cycle',
    idempotencyKey: 'idem_cycle'
  })
  const taskA = base.executionTree.milestones[0]!.slices[0]!.tasks[0]!
  const taskB = {
    ...taskA,
    id: 'task-2',
    dependsOnTaskIds: ['task-1']
  }
  const taskC = {
    ...taskA,
    id: 'task-1',
    dependsOnTaskIds: ['task-2']
  }
  base.executionTree.milestones[0]!.slices[0]!.tasks = [taskC, taskB]
  return base
}

async function settleExecution(
  execution: ReturnType<typeof composeExecutionModule>,
  opts?: { actorId?: string; jobId?: string }
): Promise<void> {
  const actorId = opts?.actorId ?? 'alice'
  for (let i = 0; i < 40; i += 1) {
    await execution.scheduler.tick()
    if (opts?.jobId) {
      try {
        const job = execution.jobs.query.get({ userId: actorId, sessionId: 'settle' }, opts.jobId)
        if (
          job.state === 'succeeded' ||
          job.state === 'failed' ||
          job.state === 'cancelled' ||
          job.state === 'paused'
        ) {
          break
        }
      } catch {
        // ignore while job not yet visible
      }
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  execution.drain()
  await new Promise((resolve) => setImmediate(resolve))
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

function successfulRuntimeEvents(role: AgentRole): AgentTurnEvent[] {
  if (role === 'slice-verifier') {
    return [
      {
        type: 'tool_call',
        name: 'complete_slice_verification',
        arguments: {
          status: 'progress-ok',
          confidence: 'high',
          summary: 'Slice evidence accepted',
          satisfiedSignals: ['task-evidence'],
          missingSignals: [],
          questionableClaims: [],
          evidenceTrace: [],
          repairSuggestions: []
        }
      },
      { type: 'completed', reason: 'scripted' }
    ]
  }
  if (role === 'milestone-verifier') {
    return [
      {
        type: 'tool_call',
        name: 'complete_milestone_verification',
        arguments: {
          status: 'passed',
          confidence: 'high',
          summary: 'Milestone evidence accepted',
          requirementTrace: [],
          sliceAssessments: [],
          repairTasks: []
        }
      },
      { type: 'completed', reason: 'scripted' }
    ]
  }
  return [
    {
      type: 'tool_call',
      name: 'report_task_result',
      arguments: {
        status: 'completed',
        summary: 'Task completed',
        changedFiles: ['src/task.ts'],
        evidence: ['task evidence'],
        validation: { ran: true, command: 'npm test', outcome: 'passed' }
      }
    },
    { type: 'completed', reason: 'scripted' }
  ]
}

describe('execution job-actions', () => {
  it('allows pause and cancel while running with none intent', () => {
    const actions = allowedJobActions({ state: 'running', controlIntent: 'none' })
    assert.deepEqual(actions.sort(), ['cancel', 'pause'].sort())
  })

  it('denies pause while already pausing', () => {
    const actions = allowedJobActions({ state: 'pausing', controlIntent: 'pause' })
    assert.ok(!actions.includes('pause'))
    assert.ok(actions.includes('continue'))
  })

  it('allows delete on terminal succeeded', () => {
    const actions = allowedJobActions({ state: 'succeeded', controlIntent: 'none' })
    assert.deepEqual(actions, ['delete'])
  })
})

describe('execution submission dedup', () => {
  it('replays same idempotency key and hash', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration045ExecutionModuleTables.up(db)
    const dedup = new JobSubmissionDedup(db)
    const submission = minimalSubmission()
    const hash = hashSubmission(submission)
    db.prepare(
      `INSERT INTO jobs (id, submission_id, submission_hash, idempotency_key, actor_id, project_id, source_draft_id, source_planning_session_id, title, workspace_root, canonical_workspace_root, state, state_revision, execution_generation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, 1, ?, ?)`
    ).run(
      'job-1',
      submission.submissionId,
      hash,
      submission.idempotencyKey,
      submission.actorId,
      submission.projectId,
      submission.source.draftId,
      submission.source.planningSessionId,
      submission.title,
      submission.workspaceRoot,
      submission.workspaceRoot,
      Date.now(),
      Date.now()
    )
    const result = dedup.checkIdempotency(submission.idempotencyKey, hash)
    assert.equal(result.kind, 'replay')
    if (result.kind === 'replay') {
      assert.equal(result.jobId, 'job-1')
    }
    db.close()
  })

  it('conflicts when same idempotency key has different hash', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration045ExecutionModuleTables.up(db)
    const dedup = new JobSubmissionDedup(db)
    db.prepare(
      `INSERT INTO jobs (id, submission_id, submission_hash, idempotency_key, actor_id, project_id, source_draft_id, source_planning_session_id, title, workspace_root, canonical_workspace_root, state, state_revision, execution_generation, created_at, updated_at)
       VALUES ('job-1', 'sub-1', 'hash-a', 'idem-1', 'alice', 'proj-1', 'draft-1', 'plan-1', 't', '/tmp', '/tmp', 'queued', 1, 1, ?, ?)`
    ).run(Date.now(), Date.now())
    const result = dedup.checkIdempotency('idem-1', 'hash-b')
    assert.equal(result.kind, 'conflict')
    db.close()
  })
})

describe('execution module integration', () => {
  it('submit → list queued → tick to succeeded with FakeAgentRuntime', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    const execution = composeExecutionModule({ db })
    execution.startup()

    const actor = { userId: 'alice', sessionId: 'sess-1' }
    const accepted = await execution.submitJob.accept(minimalSubmission())
    assert.ok(accepted.jobId)

    const listed = execution.jobs.query.list(actor)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.id, accepted.jobId)
    assert.ok(['queued', 'running'].includes(listed[0]?.state ?? ''))

    let finalState = listed[0]?.state
    for (let i = 0; i < 30; i += 1) {
      await execution.scheduler.tick()
      finalState = execution.jobs.query.get(actor, accepted.jobId).state
      if (finalState === 'succeeded') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    assert.equal(finalState, 'succeeded')
    db.close()
  })

  it('rejects DAG cycle on submit', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)
    const execution = composeExecutionModule({ db })
    await assert.rejects(
      () => execution.submitJob.accept(cycleSubmission()),
      (error: unknown) => error instanceof ExecutionValidationError
    )
    db.close()
  })

  it('pause while running moves to pausing then paused after tick', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)
    const execution = composeExecutionModule({ db })
    const actor = { userId: 'alice', sessionId: 'sess-1' }
    const accepted = await execution.submitJob.accept(minimalSubmission())
    await execution.scheduler.tick()
    const job = execution.jobs.query.get(actor, accepted.jobId)
    if (job.state === 'running') {
      execution.jobs.control.pause(actor, accepted.jobId, {
        idempotencyKey: 'pause-1',
        expectedRevision: job.stateRevision
      })
      const paused = execution.jobs.query.get(actor, accepted.jobId)
      assert.equal(paused.state, 'pausing')
    }
    execution.drain()
    await settleExecution(execution, { jobId: accepted.jobId })
    db.close()
  })

  it('cancel queued job', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)
    const execution = composeExecutionModule({ db })
    const actor = { userId: 'alice', sessionId: 'sess-1' }
    const accepted = await execution.submitJob.accept(minimalSubmission())
    const job = execution.jobs.query.get(actor, accepted.jobId)
    execution.jobs.control.cancel(actor, accepted.jobId, {
      idempotencyKey: 'cancel-1',
      expectedRevision: job.stateRevision
    })
    const cancelled = execution.jobs.query.get(actor, accepted.jobId)
    assert.equal(cancelled.state, 'cancelling')
    await settleExecution(execution, { jobId: accepted.jobId })
    db.close()
  })

  it('rejects an idempotency key reused by a different Job command', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)
    const execution = composeExecutionModule({ db })
    execution.drain()
    const actor = { userId: 'alice', sessionId: 'sess-idem-command' }
    const accepted = await execution.submitJob.accept(
      minimalSubmission({ submissionId: 'sub_command_idem', idempotencyKey: 'submit_command_idem' })
    )
    const queued = execution.jobs.query.get(actor, accepted.jobId)
    const cancelled = execution.jobs.control.cancel(actor, accepted.jobId, {
      idempotencyKey: 'same-command-key',
      expectedRevision: queued.stateRevision
    })
    const replay = execution.jobs.control.cancel(actor, accepted.jobId, {
      idempotencyKey: 'same-command-key',
      expectedRevision: queued.stateRevision
    })
    assert.deepEqual(replay, cancelled)

    assert.throws(
      () =>
        execution.jobs.control.restart(actor, accepted.jobId, {
          idempotencyKey: 'same-command-key',
          expectedRevision: cancelled.stateRevision
        }),
      (error: unknown) => error instanceof ExecutionConflictError
    )
    assert.equal(execution.jobs.query.get(actor, accepted.jobId).state, 'cancelled')
    db.close()
  })

  it('FIFO: earlier enqueue sorts before later', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)
    const execution = composeExecutionModule({ db })
    const first = await execution.submitJob.accept(
      minimalSubmission({
        submissionId: 'sub_a',
        idempotencyKey: 'idem_a',
        title: 'First'
      })
    )
    await new Promise((r) => setTimeout(r, 5))
    const second = await execution.submitJob.accept(
      minimalSubmission({
        submissionId: 'sub_b',
        idempotencyKey: 'idem_b',
        title: 'Second',
        workspaceRoot: '/tmp/codetask-exec-test-b'
      })
    )
    const ordered = db
      .prepare(
        `SELECT job_id, sequence FROM execution_queue_entries
         ORDER BY priority DESC, enqueued_at ASC, sequence ASC, job_id ASC`
      )
      .all() as Array<{ job_id: string; sequence: number }>
    assert.deepEqual(
      ordered.map((row) => row.job_id),
      [first.jobId, second.jobId]
    )
    assert.ok(ordered[0]!.sequence < ordered[1]!.sequence)
    execution.drain()
    await settleExecution(execution)
    db.close()
  })

  it('does not lose a queued Job wake while another Job is running', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    let taskTurns = 0
    const runtime = new ScriptedAgentRuntime(async (input) => {
      if (input.role === 'task-worker') {
        taskTurns += 1
        if (taskTurns === 1) {
          markFirstStarted()
          await firstGate
        }
      }
      return successfulRuntimeEvents(input.role)
    })
    const execution = composeExecutionModule({ db, agentRuntime: runtime })
    const actor = { userId: 'alice', sessionId: 'sess-lossless-wake' }
    const first = await execution.submitJob.accept(
      minimalSubmission({ submissionId: 'sub_wake_first', idempotencyKey: 'idem_wake_first' })
    )
    await firstStarted
    const second = await execution.submitJob.accept(
      minimalSubmission({
        submissionId: 'sub_wake_second',
        idempotencyKey: 'idem_wake_second',
        workspaceRoot: '/tmp/codetask-exec-test-second'
      })
    )

    releaseFirst()
    await waitUntil(
      () =>
        execution.jobs.query.get(actor, first.jobId).state === 'succeeded' &&
        execution.jobs.query.get(actor, second.jobId).state === 'succeeded',
      'both Jobs should finish without a third external wake'
    )
    assert.equal(taskTurns, 2)
    execution.drain()
    db.close()
  })

  it('refreshes run, pool, and workspace leases during a long provider turn', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    let releaseTask!: () => void
    const taskGate = new Promise<void>((resolve) => {
      releaseTask = resolve
    })
    let markTaskStarted!: () => void
    const taskStarted = new Promise<void>((resolve) => {
      markTaskStarted = resolve
    })
    const runtime = new ScriptedAgentRuntime(async (input) => {
      if (input.role === 'task-worker') {
        markTaskStarted()
        await taskGate
      }
      return successfulRuntimeEvents(input.role)
    })
    const execution = composeExecutionModule({
      db,
      agentRuntime: runtime,
      heartbeatIntervalMs: 5
    })
    const actor = { userId: 'alice', sessionId: 'sess-heartbeat' }
    const accepted = await execution.submitJob.accept(
      minimalSubmission({ submissionId: 'sub_heartbeat', idempotencyKey: 'idem_heartbeat' })
    )
    await taskStarted

    const readExpiries = (): { run: number; slot: number; workspace: number } => {
      const run = db
        .prepare(`SELECT lease_expires_at AS expiresAt FROM execution_runs WHERE job_id = ?`)
        .get(accepted.jobId) as { expiresAt: number }
      const slot = db
        .prepare(
          `SELECT lease_expires_at AS expiresAt FROM execution_pool_slots WHERE run_id IS NOT NULL`
        )
        .get() as { expiresAt: number }
      const workspace = db
        .prepare(`SELECT lease_expires_at AS expiresAt FROM workspace_leases WHERE owner_id = ?`)
        .get(accepted.jobId) as { expiresAt: number }
      return { run: run.expiresAt, slot: slot.expiresAt, workspace: workspace.expiresAt }
    }
    const before = readExpiries()
    await waitUntil(() => {
      const after = readExpiries()
      return (
        after.run > before.run && after.slot > before.slot && after.workspace > before.workspace
      )
    }, 'all Execution lease layers should be refreshed during the provider wait')

    releaseTask()
    await waitUntil(
      () => execution.jobs.query.get(actor, accepted.jobId).state === 'succeeded',
      'heartbeat test Job should finish'
    )
    execution.drain()
    db.close()
  })

  it('repair inject does not mutate job snapshot tree hash', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)
    const execution = composeExecutionModule({ db })
    execution.drain()
    const accepted = await execution.submitJob.accept(minimalSubmission())
    await new Promise((resolve) => setImmediate(resolve))
    const work = db
      .prepare(`SELECT id FROM job_work_items WHERE job_id = ? LIMIT 1`)
      .get(accepted.jobId) as { id: string }
    const before = db
      .prepare(`SELECT content_hash, execution_tree_json FROM job_snapshots WHERE job_id = ?`)
      .get(accepted.jobId) as { content_hash: string; execution_tree_json: string }

    const { createInjectRepairWorkService } =
      await import('../../packages/server-core/src/modules/execution/recovery/application/inject-repair-work.ts')
    const repair = createInjectRepairWorkService({ db })
    const result = repair.inject({
      jobId: accepted.jobId,
      generation: 0,
      parentWorkId: work.id,
      kind: 'implementation-repair',
      title: 'Fix it',
      description: 'Repair task',
      successCriteria: 'Fixed'
    })

    const after = db
      .prepare(`SELECT content_hash, execution_tree_json FROM job_snapshots WHERE job_id = ?`)
      .get(accepted.jobId) as { content_hash: string; execution_tree_json: string }
    assert.equal(after.content_hash, before.content_hash)
    assert.equal(after.execution_tree_json, before.execution_tree_json)
    assert.equal(result.contentHash, before.content_hash)

    const repairWork = db
      .prepare(`SELECT kind, parent_work_id FROM job_work_items WHERE id = ?`)
      .get(result.workId) as { kind: string; parent_work_id: string }
    assert.equal(repairWork.kind, 'implementation-repair')
    assert.equal(repairWork.parent_work_id, work.id)
    db.close()
  })
})

describe('execution continue authorizeReplay', () => {
  it('requires authorizeReplay when recovery_reason is uncertain_provider_outcome', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    const execution = composeExecutionModule({ db })
    const actor = { userId: 'alice', sessionId: 'sess-1' }
    const accepted = await execution.submitJob.accept(minimalSubmission())
    const jobId = accepted.jobId
    const now = Date.now()

    const work = db
      .prepare(`SELECT id FROM job_work_items WHERE job_id = ? LIMIT 1`)
      .get(jobId) as { id: string }

    db.prepare(
      `UPDATE jobs SET state = 'paused', recovery_reason = 'uncertain_provider_outcome', state_revision = 2, updated_at = ? WHERE id = ?`
    ).run(now, jobId)

    db.prepare(
      `INSERT INTO work_attempts (
        id, job_id, work_id, generation, run_id, attempt_number, idempotency_key,
        status, started_at, ended_at
      ) VALUES (?, ?, ?, 0, 'run-test', 1, 'attempt-idem-1', 'interrupted', ?, ?)`
    ).run('attempt-1', jobId, work.id, now, now)

    assert.throws(
      () =>
        execution.jobs.control.continue(actor, jobId, {
          idempotencyKey: 'continue-no-replay',
          expectedRevision: 2
        }),
      (error: unknown) => error instanceof ExecutionValidationError
    )

    execution.jobs.control.continue(actor, jobId, {
      idempotencyKey: 'continue-with-replay',
      expectedRevision: 2,
      authorizeReplay: true
    })

    const updated = execution.jobs.query.get(actor, jobId)
    assert.equal(updated.state, 'queued')
    assert.equal(updated.recoveryReason, null)

    const attempt = db
      .prepare(`SELECT replay_authorized_at FROM work_attempts WHERE id = 'attempt-1'`)
      .get() as { replay_authorized_at: number | null }
    assert.ok(attempt.replay_authorized_at !== null)

    execution.drain()
    await settleExecution(execution, { jobId: accepted.jobId })
    db.close()
  })
})

describe('execution slice/milestone verification', () => {
  it('progress-ok when all work succeeded; same bundle does not duplicate attempts', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    const execution = composeExecutionModule({ db })
    const actor = { userId: 'alice', sessionId: 'sess-1' }
    const accepted = await execution.submitJob.accept(minimalSubmission())
    await settleExecution(execution, { jobId: accepted.jobId })

    const detail = execution.jobs.query.get(actor, accepted.jobId)
    assert.equal(detail.state, 'succeeded')

    const attempts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM verification_attempts WHERE job_id = ? AND scope_type = 'slice'`
      )
      .get(accepted.jobId) as { n: number }
    assert.ok(Number(attempts.n) >= 1)

    const slice = db
      .prepare(`SELECT verification_state FROM job_slices WHERE job_id = ? LIMIT 1`)
      .get(accepted.jobId) as { verification_state: string }
    assert.equal(slice.verification_state, 'progress-ok')

    const before = Number(attempts.n)
    // Force another coordinator tick — bundle hash guard must not grow attempts forever
    await settleExecution(execution)
    const after = db
      .prepare(
        `SELECT COUNT(*) AS n FROM verification_attempts WHERE job_id = ? AND scope_type = 'slice'`
      )
      .get(accepted.jobId) as { n: number }
    assert.equal(Number(after.n), before)

    execution.drain()
    db.close()
  })

  it('needs-repair injects repair work without mutating snapshot tree', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    const { ScriptedAgentRuntime } =
      await import('../../packages/server-core/src/modules/execution/pool/infrastructure/scripted-agent-runtime.ts')
    const runtime = new ScriptedAgentRuntime(async (input) => {
      if (input.role === 'task-worker') {
        return [{ type: 'failed', message: 'boom' }]
      }
      if (input.role === 'slice-verifier') {
        const work = db
          .prepare(
            `SELECT id FROM job_work_items WHERE kind = 'task' ORDER BY created_at DESC LIMIT 1`
          )
          .get() as { id: string } | undefined
        assert.ok(work, 'expected a task work item for repair target')
        return [
          {
            type: 'tool_call',
            name: 'complete_slice_verification',
            arguments: {
              status: 'needs-repair',
              confidence: 'high',
              summary: 'Task failed; inject implementation repair',
              satisfiedSignals: [],
              missingSignals: [work.id],
              questionableClaims: [],
              evidenceTrace: [],
              repairSuggestions: [
                {
                  kind: 'implementation-repair',
                  title: 'Repair failed task',
                  description: 'Re-run failed work',
                  targetWorkId: work.id,
                  successCriteria: 'Work succeeds'
                }
              ]
            }
          },
          { type: 'completed', reason: 'scripted' }
        ]
      }
      return [
        {
          type: 'tool_call',
          name: 'complete_milestone_verification',
          arguments: {
            status: 'inconclusive',
            confidence: 'low',
            summary: 'Waiting for slice repair',
            requirementTrace: [],
            sliceAssessments: [],
            repairTasks: []
          }
        },
        { type: 'completed', reason: 'scripted' }
      ]
    })
    const execution = composeExecutionModule({ db, agentRuntime: runtime })
    const accepted = await execution.submitJob.accept(
      minimalSubmission({ submissionId: 'sub_repair_ver', idempotencyKey: 'idem_repair_ver' })
    )
    await settleExecution(execution, { jobId: accepted.jobId })

    const before = db
      .prepare(`SELECT content_hash FROM job_snapshots WHERE job_id = ?`)
      .get(accepted.jobId) as { content_hash: string }

    // Mark work failed + terminal so slice verify can run (scripted failure already did)
    const slice = db
      .prepare(`SELECT verification_state, state FROM job_slices WHERE job_id = ? LIMIT 1`)
      .get(accepted.jobId) as { verification_state: string; state: string }

    // After failed work, verification should have run to needs-repair and injected repair
    assert.equal(slice.verification_state, 'needs-repair')

    const repairs = db
      .prepare(
        `SELECT COUNT(*) AS n FROM job_work_items WHERE job_id = ? AND kind = 'implementation-repair'`
      )
      .get(accepted.jobId) as { n: number }
    assert.ok(Number(repairs.n) >= 1)

    const after = db
      .prepare(`SELECT content_hash FROM job_snapshots WHERE job_id = ?`)
      .get(accepted.jobId) as { content_hash: string }
    assert.equal(after.content_hash, before.content_hash)

    execution.drain()
    db.close()
  })
})

describe('execution ScriptedAgentRuntime provider path', () => {
  it('forwards provider/role/prompt and can fail the work attempt', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    const { ScriptedAgentRuntime } =
      await import('../../packages/server-core/src/modules/execution/pool/infrastructure/scripted-agent-runtime.ts')
    const runtime = new ScriptedAgentRuntime(async (input) => {
      if (input.role === 'slice-verifier') {
        return [
          {
            type: 'tool_call',
            name: 'complete_slice_verification',
            arguments: {
              status: 'blocked',
              confidence: 'high',
              summary: 'Work failed; slice blocked',
              satisfiedSignals: [],
              missingSignals: [],
              questionableClaims: [],
              evidenceTrace: [],
              repairSuggestions: []
            }
          },
          { type: 'completed', reason: 'scripted' }
        ]
      }
      if (input.role === 'milestone-verifier') {
        return [
          {
            type: 'tool_call',
            name: 'complete_milestone_verification',
            arguments: {
              status: 'blocked',
              confidence: 'high',
              summary: 'Blocked after failed work',
              requirementTrace: [],
              sliceAssessments: [],
              repairTasks: []
            }
          },
          { type: 'completed', reason: 'scripted' }
        ]
      }
      assert.equal(input.role, 'task-worker')
      assert.equal(input.provider, 'opencode')
      assert.ok(input.prompt.includes('Implement') || input.prompt.length > 0)
      return [{ type: 'failed', message: 'provider crashed after start' }]
    })

    const execution = composeExecutionModule({ db, agentRuntime: runtime })
    const accepted = await execution.submitJob.accept(
      minimalSubmission({ submissionId: 'sub_scripted', idempotencyKey: 'idem_scripted' })
    )
    await settleExecution(execution, { jobId: accepted.jobId })

    assert.ok(runtime.turns.length >= 1)
    assert.equal(runtime.turns[0]!.provider, 'opencode')
    assert.equal(runtime.turns[0]!.capabilityProfile, 'task-sandbox')
    assert.equal(runtime.turns[0]!.role, 'task-worker')

    const work = db
      .prepare(`SELECT state FROM job_work_items WHERE job_id = ? AND kind = 'task' LIMIT 1`)
      .get(accepted.jobId) as { state: string }
    assert.equal(work.state, 'failed')

    execution.drain()
    db.close()
  })

  it('completes job when scripted runtime yields completed', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    const { ScriptedAgentRuntime } =
      await import('../../packages/server-core/src/modules/execution/pool/infrastructure/scripted-agent-runtime.ts')
    const runtime = new ScriptedAgentRuntime(async (input) => {
      if (input.role === 'slice-verifier') {
        return [
          {
            type: 'tool_call',
            name: 'complete_slice_verification',
            arguments: {
              status: 'progress-ok',
              confidence: 'high',
              summary: 'Slice ok via scripted verifier',
              satisfiedSignals: ['scripted'],
              missingSignals: [],
              questionableClaims: [],
              evidenceTrace: [],
              repairSuggestions: []
            }
          },
          { type: 'completed', reason: 'scripted' }
        ]
      }
      if (input.role === 'milestone-verifier') {
        return [
          {
            type: 'tool_call',
            name: 'complete_milestone_verification',
            arguments: {
              status: 'passed',
              confidence: 'high',
              summary: 'Milestone passed via scripted verifier',
              requirementTrace: [],
              sliceAssessments: [],
              repairTasks: []
            }
          },
          { type: 'completed', reason: 'scripted' }
        ]
      }
      return [
        {
          type: 'tool_call',
          name: 'report_task_result',
          arguments: {
            status: 'completed',
            summary: 'Task done via MCP report_task_result',
            changedFiles: ['src/a.ts'],
            evidence: ['wrote src/a.ts'],
            validation: { ran: true, outcome: 'passed' }
          }
        },
        { type: 'completed', reason: 'scripted' }
      ]
    })

    const execution = composeExecutionModule({ db, agentRuntime: runtime })
    const actor = { userId: 'alice', sessionId: 'sess-1' }
    const accepted = await execution.submitJob.accept(
      minimalSubmission({ submissionId: 'sub_scripted_ok', idempotencyKey: 'idem_scripted_ok' })
    )
    await settleExecution(execution, { jobId: accepted.jobId })

    assert.ok(runtime.turns.length >= 1)
    const detail = execution.jobs.query.get(actor, accepted.jobId)
    assert.equal(detail.state, 'succeeded')

    const sliceTurn = runtime.turns.find((turn) => turn.role === 'slice-verifier')
    const milestoneTurn = runtime.turns.find((turn) => turn.role === 'milestone-verifier')
    assert.ok(sliceTurn)
    assert.ok(milestoneTurn)
    assert.match(sliceTurn.prompt, /"requirementsMarkdown": "# Req"/)
    assert.match(sliceTurn.prompt, /"successCriteria": "Slice done"/)
    assert.match(sliceTurn.prompt, /"changedFiles": \[/)
    assert.match(sliceTurn.prompt, /"src\/a\.ts"/)
    assert.match(sliceTurn.prompt, /"outcome": "passed"/)
    assert.match(milestoneTurn.prompt, /"successCriteria": "Done"/)
    assert.match(milestoneTurn.prompt, /"summary": "Slice ok via scripted verifier"/)

    const storedEvidence = db
      .prepare(`SELECT evidence_json AS evidenceJson FROM work_results LIMIT 1`)
      .get() as { evidenceJson: string }
    assert.equal(JSON.parse(storedEvidence.evidenceJson).changedFiles[0], 'src/a.ts')

    const bundles = db
      .prepare(
        `SELECT scope_type AS scopeType, evidence_bundle_json AS evidenceBundleJson
         FROM verification_attempts
         WHERE job_id = ?`
      )
      .all(accepted.jobId) as Array<{ scopeType: string; evidenceBundleJson: string }>
    assert.deepEqual(bundles.map((row) => row.scopeType).sort(), ['milestone', 'slice'])
    assert.ok(bundles.every((row) => JSON.parse(row.evidenceBundleJson).schemaVersion === 1))

    execution.drain()
    db.close()
  })

  it('pauses promptly while a Slice verifier turn is active', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    let markSliceStarted!: () => void
    const sliceStarted = new Promise<void>((resolve) => {
      markSliceStarted = resolve
    })
    const runtime = new ScriptedAgentRuntime(async (input) => {
      if (input.role !== 'slice-verifier') return successfulRuntimeEvents(input.role)
      markSliceStarted()
      return await new Promise<AgentTurnEvent[]>((resolve) => {
        const abort = (): void => resolve([{ type: 'failed', message: 'aborted by Job control' }])
        if (input.signal?.aborted) abort()
        else input.signal?.addEventListener('abort', abort, { once: true })
      })
    })
    const execution = composeExecutionModule({ db, agentRuntime: runtime })
    const actor = { userId: 'alice', sessionId: 'sess-pause-verifier' }
    const accepted = await execution.submitJob.accept(
      minimalSubmission({
        submissionId: 'sub_pause_verifier',
        idempotencyKey: 'idem_pause_verifier'
      })
    )
    await sliceStarted

    const running = execution.jobs.query.get(actor, accepted.jobId)
    assert.equal(running.state, 'running')
    execution.jobs.control.pause(actor, accepted.jobId, {
      idempotencyKey: 'pause-active-verifier',
      expectedRevision: running.stateRevision
    })
    await waitUntil(
      () => execution.jobs.query.get(actor, accepted.jobId).state === 'paused',
      'Job should settle to paused after aborting its verifier turn'
    )

    const abortedAttempts = db
      .prepare(
        `SELECT COUNT(*) AS count FROM verification_attempts
         WHERE job_id = ? AND scope_type = 'slice'`
      )
      .get(accepted.jobId) as { count: number }
    assert.equal(abortedAttempts.count, 0)
    const sliceTurn = runtime.turns.find((turn) => turn.role === 'slice-verifier')
    assert.equal(sliceTurn?.signal?.aborted, true)
    execution.drain()
    db.close()
  })
})

describe('execution MCP report_task_result path', () => {
  it('report_task_result persists work_results and succeeds job', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    const { ScriptedAgentRuntime } =
      await import('../../packages/server-core/src/modules/execution/pool/infrastructure/scripted-agent-runtime.ts')
    const runtime = new ScriptedAgentRuntime(async (input) => {
      if (input.role === 'slice-verifier') {
        return [
          {
            type: 'tool_call',
            name: 'complete_slice_verification',
            arguments: {
              status: 'progress-ok',
              confidence: 'high',
              summary: 'Slice ok',
              satisfiedSignals: [],
              missingSignals: [],
              questionableClaims: [],
              evidenceTrace: [],
              repairSuggestions: []
            }
          },
          { type: 'completed', reason: 'mcp-reported' }
        ]
      }
      if (input.role === 'milestone-verifier') {
        return [
          {
            type: 'tool_call',
            name: 'complete_milestone_verification',
            arguments: {
              status: 'passed',
              confidence: 'high',
              summary: 'Milestone passed',
              requirementTrace: [],
              sliceAssessments: [],
              repairTasks: []
            }
          },
          { type: 'completed', reason: 'mcp-reported' }
        ]
      }
      return [
        {
          type: 'tool_call',
          name: 'report_task_result',
          arguments: {
            status: 'completed',
            summary: 'Implemented via provider MCP',
            changedFiles: ['readme.md'],
            evidence: ['updated readme'],
            validation: { ran: true, outcome: 'passed' }
          }
        },
        { type: 'completed', reason: 'mcp-reported' }
      ]
    })

    const execution = composeExecutionModule({ db, agentRuntime: runtime })
    const actor = { userId: 'alice', sessionId: 'sess-1' }
    const accepted = await execution.submitJob.accept(
      minimalSubmission({ submissionId: 'sub_mcp', idempotencyKey: 'idem_mcp' })
    )
    await settleExecution(execution, { jobId: accepted.jobId })

    const detail = execution.jobs.query.get(actor, accepted.jobId)
    assert.equal(detail.state, 'succeeded')

    const result = db
      .prepare(
        `SELECT wr.status AS status, wr.summary AS summary FROM work_results wr
         JOIN work_attempts wa ON wa.id = wr.attempt_id
         WHERE wa.job_id = ? LIMIT 1`
      )
      .get(accepted.jobId) as { status: string; summary: string } | undefined
    assert.ok(result, 'expected work_results row')
    assert.equal(result.status, 'completed')
    assert.match(result.summary, /Implemented via provider MCP/)

    execution.drain()
    db.close()
  })
})

describe('execution migration 047', () => {
  it('drop_control_plane_tables removes control_jobs', async () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE control_jobs (id TEXT PRIMARY KEY NOT NULL)`)
    db.exec(`INSERT INTO control_jobs (id) VALUES ('cj-1')`)
    const { migration047DropControlPlaneTables } =
      await import('../../packages/database/src/migrations/drop-control-plane.ts')
    migration047DropControlPlaneTables.up(db)
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'control_jobs'`)
      .get() as { name: string } | undefined
    assert.equal(row, undefined)
    db.close()
  })
})
