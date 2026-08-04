import type Database from 'better-sqlite3'
import type { WorkDependencyRecord, WorkItemRecord } from '../../work/domain/work-item.ts'
import { ExecutionNotFoundError } from '../../shared.ts'

function mapWork(row: Record<string, unknown>): WorkItemRecord {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    generation: row.generation as number,
    sourceTaskId: row.source_task_id as string,
    parentWorkId: (row.parent_work_id as string | null) ?? null,
    milestoneId: row.milestone_id as string,
    sliceId: row.slice_id as string,
    kind: row.kind as WorkItemRecord['kind'],
    sortOrder: row.sort_order as number,
    title: row.title as string,
    description: row.description as string,
    contextMarkdown: row.context_markdown as string,
    abilityCode: row.ability_code as string,
    providerCode: row.provider_code as WorkItemRecord['providerCode'],
    successCriteria: row.success_criteria as string,
    canRunInParallel: Boolean(row.can_run_in_parallel),
    state: row.state as WorkItemRecord['state'],
    stateRevision: row.state_revision as number,
    lastErrorJson: (row.last_error_json as string | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number
  }
}

export class WorkRepository {
  constructor(private readonly db: Database.Database) {}

  listWork(jobId: string, generation: number): WorkItemRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM job_work_items WHERE job_id = ? AND generation = ? ORDER BY sort_order`
      )
      .all(jobId, generation) as Record<string, unknown>[]
    return rows.map(mapWork)
  }

  getWork(jobId: string, workId: string): WorkItemRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM job_work_items WHERE job_id = ? AND id = ?`)
      .get(jobId, workId) as Record<string, unknown> | undefined
    return row ? mapWork(row) : null
  }

  requireWork(jobId: string, workId: string): WorkItemRecord {
    const work = this.getWork(jobId, workId)
    if (!work) throw new ExecutionNotFoundError('Work not found')
    return work
  }

  listDependencies(jobId: string, generation: number): WorkDependencyRecord[] {
    return this.db
      .prepare(`SELECT * FROM job_work_dependencies WHERE job_id = ? AND generation = ?`)
      .all(jobId, generation) as WorkDependencyRecord[]
  }

  casWorkState(input: {
    jobId: string
    workId: string
    expectedRevision: number
    nextState: WorkItemRecord['state']
    updatedAt: number
  }): WorkItemRecord {
    const result = this.db
      .prepare(
        `UPDATE job_work_items SET state = ?, state_revision = state_revision + 1, updated_at = ?
         WHERE job_id = ? AND id = ? AND state_revision = ?`
      )
      .run(input.nextState, input.updatedAt, input.jobId, input.workId, input.expectedRevision)
    if (result.changes === 0) throw new Error('Work CAS failed')
    return this.requireWork(input.jobId, input.workId)
  }

  succeededWorkIds(jobId: string, generation: number): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT id FROM job_work_items WHERE job_id = ? AND generation = ? AND state IN ('succeeded', 'skipped')`
      )
      .all(jobId, generation) as Array<{ id: string }>
    return new Set(rows.map((r) => r.id))
  }

  pendingCount(jobId: string, generation: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM job_work_items
         WHERE job_id = ? AND generation = ? AND state = 'pending'`
      )
      .get(jobId, generation) as { c: number }
    return row.c
  }

  getEvidence(attemptId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare(
        `SELECT wr.* FROM work_results wr
         JOIN work_attempts wa ON wa.id = wr.attempt_id
         WHERE wa.id = ?`
      )
      .get(attemptId) as Record<string, unknown> | undefined
    return row ?? null
  }

  getLatestAttempt(workId: string): { id: string; status: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, status FROM work_attempts WHERE work_id = ? ORDER BY attempt_number DESC LIMIT 1`
      )
      .get(workId) as { id: string; status: string } | undefined
    return row ?? null
  }

  getEvidenceForWork(jobId: string, workId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare(
        `SELECT wr.* FROM work_results wr
         JOIN work_attempts wa ON wa.id = wr.attempt_id
         WHERE wa.job_id = ? AND wa.work_id = ?
         ORDER BY wa.attempt_number DESC LIMIT 1`
      )
      .get(jobId, workId) as Record<string, unknown> | undefined
    return row ?? null
  }
}
