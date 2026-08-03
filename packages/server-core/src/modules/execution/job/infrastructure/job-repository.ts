import type Database from 'better-sqlite3'
import type {
  JobAction,
  JobDetail,
  JobSummary,
  JobTreeDto,
  WorkItemDto
} from '@codetask/contracts'
import type { JobRecord } from '../domain/job-state.ts'
import { allowedJobActions } from '../domain/job-actions.ts'
import { isoFromMs } from '../../shared.ts'
import { ExecutionNotFoundError } from '../../shared.ts'

function mapJobRow(row: Record<string, unknown>): JobRecord {
  return {
    id: row.id as string,
    submissionId: row.submission_id as string,
    submissionHash: row.submission_hash as string,
    idempotencyKey: row.idempotency_key as string,
    actorId: row.actor_id as string,
    projectId: row.project_id as string,
    sourceDraftId: row.source_draft_id as string,
    sourcePlanningSessionId: row.source_planning_session_id as string,
    title: row.title as string,
    summary: row.summary as string,
    workspaceRoot: row.workspace_root as string,
    canonicalWorkspaceRoot: row.canonical_workspace_root as string,
    state: row.state as JobRecord['state'],
    stateRevision: row.state_revision as number,
    controlIntent: row.control_intent as JobRecord['controlIntent'],
    executionGeneration: row.execution_generation as number,
    currentRunId: (row.current_run_id as string | null) ?? null,
    suspensionKind: (row.suspension_kind as string | null) ?? null,
    recoveryReason: (row.recovery_reason as string | null) ?? null,
    lastErrorJson: (row.last_error_json as string | null) ?? null,
    queuedAt: (row.queued_at as number | null) ?? null,
    startedAt: (row.started_at as number | null) ?? null,
    terminalAt: (row.terminal_at as number | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number
  }
}

export class JobRepository {
  constructor(private readonly db: Database.Database) {}

  getById(jobId: string): JobRecord | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId)
    return row ? mapJobRow(row as Record<string, unknown>) : null
  }

  requireById(jobId: string): JobRecord {
    const job = this.getById(jobId)
    if (!job) throw new ExecutionNotFoundError('Job not found')
    return job
  }

  listByActor(actorId: string): JobRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE actor_id = ? ORDER BY updated_at DESC`)
      .all(actorId) as Record<string, unknown>[]
    return rows.map(mapJobRow)
  }

  casUpdateState(input: {
    jobId: string
    expectedRevision: number
    next: Partial<
      Pick<
        JobRecord,
        | 'state'
        | 'stateRevision'
        | 'controlIntent'
        | 'executionGeneration'
        | 'currentRunId'
        | 'suspensionKind'
        | 'recoveryReason'
        | 'lastErrorJson'
        | 'queuedAt'
        | 'startedAt'
        | 'terminalAt'
      >
    > & { updatedAt: number }
  }): JobRecord {
    const current = this.requireById(input.jobId)
    if (current.stateRevision !== input.expectedRevision) {
      throw new Error('CAS revision mismatch')
    }
    const state = input.next.state ?? current.state
    const stateRevision = input.next.stateRevision ?? current.stateRevision + 1
    const controlIntent = input.next.controlIntent ?? current.controlIntent
    const executionGeneration = input.next.executionGeneration ?? current.executionGeneration
    const currentRunId =
      input.next.currentRunId !== undefined ? input.next.currentRunId : current.currentRunId
    const suspensionKind =
      input.next.suspensionKind !== undefined ? input.next.suspensionKind : current.suspensionKind
    const recoveryReason =
      input.next.recoveryReason !== undefined ? input.next.recoveryReason : current.recoveryReason
    const lastErrorJson =
      input.next.lastErrorJson !== undefined ? input.next.lastErrorJson : current.lastErrorJson
    const queuedAt = input.next.queuedAt !== undefined ? input.next.queuedAt : current.queuedAt
    const startedAt = input.next.startedAt !== undefined ? input.next.startedAt : current.startedAt
    const terminalAt =
      input.next.terminalAt !== undefined ? input.next.terminalAt : current.terminalAt

    this.db
      .prepare(
        `UPDATE jobs SET
          state = ?, state_revision = ?, control_intent = ?,
          execution_generation = ?, current_run_id = ?,
          suspension_kind = ?, recovery_reason = ?, last_error_json = ?,
          queued_at = ?, started_at = ?, terminal_at = ?, updated_at = ?
         WHERE id = ? AND state_revision = ?`
      )
      .run(
        state,
        stateRevision,
        controlIntent,
        executionGeneration,
        currentRunId,
        suspensionKind,
        recoveryReason,
        lastErrorJson,
        queuedAt,
        startedAt,
        terminalAt,
        input.next.updatedAt,
        input.jobId,
        input.expectedRevision
      )
    return this.requireById(input.jobId)
  }

  toSummary(job: JobRecord, _queuePosition: number | null): JobSummary {
    return {
      id: job.id,
      title: job.title,
      summary: job.summary,
      state: job.state,
      stateRevision: job.stateRevision,
      controlIntent: job.controlIntent,
      executionGeneration: job.executionGeneration,
      projectId: job.projectId,
      actorId: job.actorId,
      workspaceRoot: job.workspaceRoot,
      queuedAt: job.queuedAt ? isoFromMs(job.queuedAt) : null,
      startedAt: job.startedAt ? isoFromMs(job.startedAt) : null,
      terminalAt: job.terminalAt ? isoFromMs(job.terminalAt) : null,
      availableActions: allowedJobActions({
        state: job.state,
        controlIntent: job.controlIntent
      }),
      recoveryReason: job.recoveryReason,
      lastError: job.lastErrorJson ? JSON.parse(job.lastErrorJson) : undefined
    }
  }

  toDetail(job: JobRecord, queuePosition: number | null): JobDetail {
    return {
      ...this.toSummary(job, queuePosition),
      sourceDraftId: job.sourceDraftId,
      sourcePlanningSessionId: job.sourcePlanningSessionId,
      currentRunId: job.currentRunId,
      suspensionKind: job.suspensionKind,
      queuePosition,
      createdAt: isoFromMs(job.createdAt),
      updatedAt: isoFromMs(job.updatedAt)
    }
  }

  getTree(jobId: string, generation: number): JobTreeDto {
    this.requireById(jobId)
    const milestones = this.db
      .prepare(
        `SELECT * FROM job_milestones WHERE job_id = ? AND generation = ? ORDER BY sort_order`
      )
      .all(jobId, generation) as Array<Record<string, unknown>>

    const result: JobTreeDto = {
      jobId,
      generation,
      milestones: []
    }

    for (const m of milestones) {
      const slices = this.db
        .prepare(
          `SELECT * FROM job_slices WHERE job_id = ? AND generation = ? AND milestone_id = ? ORDER BY sort_order`
        )
        .all(jobId, generation, m.id) as Array<Record<string, unknown>>

      result.milestones.push({
        id: m.id as string,
        sourceMilestoneId: m.source_milestone_id as string,
        title: m.title as string,
        description: m.description as string,
        successCriteria: m.success_criteria as string,
        state: m.state as string,
        sortOrder: m.sort_order as number,
        slices: slices.map((s) => {
          const workRows = this.db
            .prepare(
              `SELECT * FROM job_work_items WHERE job_id = ? AND generation = ? AND slice_id = ? ORDER BY sort_order`
            )
            .all(jobId, generation, s.id) as Array<Record<string, unknown>>
          return {
            id: s.id as string,
            sourceSliceId: s.source_slice_id as string,
            title: s.title as string,
            description: s.description as string,
            successCriteria: s.success_criteria as string,
            state: s.state as string,
            verificationState: s.verification_state as string,
            sortOrder: s.sort_order as number,
            workItems: workRows.map((w) => this.mapWorkRow(w))
          }
        })
      })
    }
    return result
  }

  mapWorkRow(row: Record<string, unknown>): WorkItemDto {
    return {
      id: row.id as string,
      jobId: row.job_id as string,
      generation: row.generation as number,
      sourceTaskId: row.source_task_id as string,
      parentWorkId: (row.parent_work_id as string | null) ?? null,
      milestoneId: row.milestone_id as string,
      sliceId: row.slice_id as string,
      kind: row.kind as WorkItemDto['kind'],
      title: row.title as string,
      description: row.description as string,
      contextMarkdown: row.context_markdown as string,
      abilityCode: row.ability_code as string,
      providerCode: row.provider_code as WorkItemDto['providerCode'],
      successCriteria: row.success_criteria as string,
      canRunInParallel: Boolean(row.can_run_in_parallel),
      state: row.state as WorkItemDto['state'],
      stateRevision: row.state_revision as number,
      sortOrder: row.sort_order as number
    }
  }

  getCommandReceipt(
    actorId: string,
    idempotencyKey: string
  ): {
    jobId: string
    command: JobAction
    requestHash: string
    responseJson: string
  } | null {
    const row = this.db
      .prepare(
        `SELECT job_id, command, request_hash, response_json
         FROM job_command_receipts
         WHERE actor_id = ? AND idempotency_key = ?`
      )
      .get(actorId, idempotencyKey) as
      | {
          job_id: string
          command: JobAction
          request_hash: string
          response_json: string
        }
      | undefined
    return row
      ? {
          jobId: row.job_id,
          command: row.command,
          requestHash: row.request_hash,
          responseJson: row.response_json
        }
      : null
  }

  saveCommandReceipt(input: {
    actorId: string
    idempotencyKey: string
    jobId: string
    command: JobAction
    requestHash: string
    responseJson: string
    createdAt: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO job_command_receipts (
          actor_id, idempotency_key, job_id, command, request_hash, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.actorId,
        input.idempotencyKey,
        input.jobId,
        input.command,
        input.requestHash,
        input.responseJson,
        input.createdAt
      )
  }

  deleteJob(jobId: string): void {
    this.db.prepare(`DELETE FROM jobs WHERE id = ?`).run(jobId)
  }
}
