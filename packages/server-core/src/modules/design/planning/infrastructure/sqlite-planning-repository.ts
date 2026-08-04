import type Database from 'better-sqlite3'
import type {
  ExecutionTreeSnapshot,
  PlanningSessionStatus,
  ReferenceManifest
} from '@codetask/contracts'
import { DesignConflictError, stableHash } from '../../shared.ts'
import type { PlanningRunRecord, PlanningSessionRecord } from '../domain/planning.ts'
import type { PlanningRepository } from '../application/planning-application.ts'

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T
}

type SessionRow = {
  id: string
  actor_id: string
  project_id: string
  source_draft_id: string
  draft_snapshot_json: string
  reference_snapshot_id: string | null
  execution_profile_json: string
  planner_settings_snapshot_json: string
  planner_settings_hash: string
  status: PlanningSessionStatus
  active_run_id: string | null
  tree_revision: number
  published_job_id: string | null
  last_error_json: string | null
  created_at: number
  updated_at: number
  published_at: number | null
}

export class SqlitePlanningRepository implements PlanningRepository {
  constructor(private readonly db: Database.Database) {}

  async getSession(sessionId: string): Promise<PlanningSessionRecord | null> {
    const row = this.db.prepare(`SELECT * FROM planning_sessions WHERE id = ?`).get(sessionId) as
      | SessionRow
      | undefined
    return row ? this.mapSession(row) : null
  }

  async listActiveForDraft(draftId: string): Promise<PlanningSessionRecord[]> {
    const rows = this.db
      .prepare(`SELECT * FROM planning_sessions WHERE source_draft_id = ?`)
      .all(draftId) as SessionRow[]
    return rows.map((r) => this.mapSession(r))
  }

  async insertSession(session: PlanningSessionRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO planning_sessions (
          id, actor_id, project_id, source_draft_id, draft_snapshot_json, reference_snapshot_id,
          execution_profile_json, planner_settings_snapshot_json, planner_settings_hash,
          status, active_run_id, tree_revision, published_job_id, last_error_json,
          created_at, updated_at, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.actorId,
        session.projectId,
        session.sourceDraftId,
        session.draftSnapshotJson,
        session.referenceSnapshotId,
        JSON.stringify(session.executionProfile),
        session.plannerSettingsSnapshotJson,
        session.plannerSettingsHash,
        session.status,
        session.activeRunId,
        session.treeRevision,
        session.publishedJobId,
        session.lastErrorJson,
        session.createdAt,
        session.updatedAt,
        session.publishedAt
      )
  }

  async updateSession(
    session: PlanningSessionRecord,
    expectedTreeRevision?: number
  ): Promise<PlanningSessionRecord> {
    const result = this.db
      .prepare(
        `UPDATE planning_sessions SET
          draft_snapshot_json = ?, reference_snapshot_id = ?, execution_profile_json = ?,
          planner_settings_snapshot_json = ?, planner_settings_hash = ?,
          status = ?, active_run_id = ?, tree_revision = ?, published_job_id = ?,
          last_error_json = ?, updated_at = ?, published_at = ?
        WHERE id = ? ${expectedTreeRevision === undefined ? '' : 'AND tree_revision = ?'}`
      )
      .run(
        ...(expectedTreeRevision === undefined
          ? [
              session.draftSnapshotJson,
              session.referenceSnapshotId,
              JSON.stringify(session.executionProfile),
              session.plannerSettingsSnapshotJson,
              session.plannerSettingsHash,
              session.status,
              session.activeRunId,
              session.treeRevision,
              session.publishedJobId,
              session.lastErrorJson,
              session.updatedAt,
              session.publishedAt,
              session.id
            ]
          : [
              session.draftSnapshotJson,
              session.referenceSnapshotId,
              JSON.stringify(session.executionProfile),
              session.plannerSettingsSnapshotJson,
              session.plannerSettingsHash,
              session.status,
              session.activeRunId,
              session.treeRevision,
              session.publishedJobId,
              session.lastErrorJson,
              session.updatedAt,
              session.publishedAt,
              session.id,
              expectedTreeRevision
            ])
      )
    if (result.changes !== 1) throw new DesignConflictError()
    return (await this.getSession(session.id))!
  }

  async insertRun(run: PlanningRunRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO planning_runs (
          id, planning_session_id, status, attempt_no, provider, model,
          fencing_token, started_at, finished_at, error_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.planningSessionId,
        run.status,
        run.attemptNo,
        run.provider,
        run.model,
        run.fencingToken,
        run.startedAt,
        run.finishedAt,
        run.errorJson
      )
  }

  async updateRun(run: PlanningRunRecord): Promise<void> {
    this.db
      .prepare(`UPDATE planning_runs SET status = ?, finished_at = ?, error_json = ? WHERE id = ?`)
      .run(run.status, run.finishedAt, run.errorJson, run.id)
  }

  async getRun(runId: string): Promise<PlanningRunRecord | null> {
    const row = this.db
      .prepare(
        `SELECT id, planning_session_id, status, attempt_no, provider, model,
                fencing_token, started_at, finished_at, error_json
         FROM planning_runs WHERE id = ?`
      )
      .get(runId) as
      | {
          id: string
          planning_session_id: string
          status: PlanningRunRecord['status']
          attempt_no: number
          provider: string
          model: string | null
          fencing_token: string
          started_at: number
          finished_at: number | null
          error_json: string | null
        }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      planningSessionId: row.planning_session_id,
      status: row.status,
      attemptNo: row.attempt_no,
      provider: row.provider,
      model: row.model,
      fencingToken: row.fencing_token,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      errorJson: row.error_json
    }
  }

  async saveReferenceSnapshot(input: {
    id: string
    draftId: string
    draftLockRevision: number
    manifest: ReferenceManifest
    contentHash: string
    createdAt: number
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO draft_reference_snapshots (
          id, draft_id, draft_lock_revision, manifest_json, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.draftId,
        input.draftLockRevision,
        JSON.stringify(input.manifest),
        input.contentHash,
        input.createdAt
      )
  }

  async getReferenceManifest(snapshotId: string): Promise<ReferenceManifest | null> {
    const row = this.db
      .prepare(`SELECT manifest_json FROM draft_reference_snapshots WHERE id = ?`)
      .get(snapshotId) as { manifest_json: string } | undefined
    return row ? parseJson<ReferenceManifest>(row.manifest_json) : null
  }

  async saveTree(input: {
    planId: string
    sessionId: string
    tree: ExecutionTreeSnapshot
    contentHash: string
  }): Promise<void> {
    const planRowId = `${input.sessionId}:${input.tree.revision}`
    const tx = this.db.transaction(() => {
      const oldPlans = this.db
        .prepare(`SELECT id FROM execution_plans WHERE planning_session_id = ?`)
        .all(input.sessionId) as Array<{ id: string }>
      for (const old of oldPlans) {
        this.db.prepare(`DELETE FROM execution_plan_task_references WHERE plan_id = ?`).run(old.id)
        this.db.prepare(`DELETE FROM execution_plan_dependencies WHERE plan_id = ?`).run(old.id)
        this.db.prepare(`DELETE FROM execution_plan_tasks WHERE plan_id = ?`).run(old.id)
        this.db.prepare(`DELETE FROM execution_plan_slices WHERE plan_id = ?`).run(old.id)
        this.db.prepare(`DELETE FROM execution_plan_milestones WHERE plan_id = ?`).run(old.id)
        this.db.prepare(`DELETE FROM execution_plans WHERE id = ?`).run(old.id)
      }
      this.db
        .prepare(
          `INSERT INTO execution_plans (id, planning_session_id, revision, status, content_hash, created_at)
           VALUES (?, ?, ?, 'current', ?, ?)`
        )
        .run(planRowId, input.sessionId, input.tree.revision, input.contentHash, Date.now())

      input.tree.milestones.forEach((milestone, mi) => {
        this.db
          .prepare(
            `INSERT INTO execution_plan_milestones (
              id, plan_id, sort_order, title, description, success_criteria, confirmed
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            milestone.id,
            planRowId,
            mi,
            milestone.title,
            milestone.description,
            milestone.successCriteria,
            milestone.confirmed ? 1 : 0
          )
        milestone.slices.forEach((slice, si) => {
          this.db
            .prepare(
              `INSERT INTO execution_plan_slices (
                id, plan_id, milestone_id, sort_order, title, description, success_criteria, confirmed
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              slice.id,
              planRowId,
              milestone.id,
              si,
              slice.title,
              slice.description,
              slice.successCriteria,
              slice.confirmed ? 1 : 0
            )
          slice.tasks.forEach((task, ti) => {
            this.db
              .prepare(
                `INSERT INTO execution_plan_tasks (
                  id, plan_id, slice_id, sort_order, title, description, task_kind,
                  ability_code, core_code, context_markdown, success_criteria,
                  reference_reason, can_run_in_parallel, confirmed
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                task.id,
                planRowId,
                slice.id,
                ti,
                task.title,
                task.description,
                task.taskKind,
                task.abilityCode,
                task.coreCode,
                task.contextMarkdown,
                task.successCriteria,
                '',
                task.canRunInParallel ? 1 : 0,
                task.confirmed ? 1 : 0
              )
            for (const refId of task.referenceIds) {
              this.db
                .prepare(
                  `INSERT INTO execution_plan_task_references (plan_id, task_id, reference_id)
                   VALUES (?, ?, ?)`
                )
                .run(planRowId, task.id, refId)
            }
            for (const dep of task.dependsOnTaskIds) {
              this.db
                .prepare(
                  `INSERT INTO execution_plan_dependencies (plan_id, from_node_id, to_node_id, dependency_kind)
                   VALUES (?, ?, ?, 'task')`
                )
                .run(planRowId, dep, task.id)
            }
          })
        })
      })

      this.db
        .prepare(
          `INSERT OR REPLACE INTO execution_plan_revisions (
            planning_session_id, revision, snapshot_gzip, content_hash, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, NULL)`
        )
        .run(
          input.sessionId,
          input.tree.revision,
          Buffer.from(JSON.stringify(input.tree)).toString('base64'),
          input.contentHash,
          Date.now()
        )
    })
    tx()
  }

  async getTree(sessionId: string): Promise<ExecutionTreeSnapshot | null> {
    const plan = this.db
      .prepare(
        `SELECT id, revision FROM execution_plans
         WHERE planning_session_id = ? AND status = 'current'
         ORDER BY revision DESC LIMIT 1`
      )
      .get(sessionId) as { id: string; revision: number } | undefined
    if (!plan) return null

    const milestones = this.db
      .prepare(`SELECT * FROM execution_plan_milestones WHERE plan_id = ? ORDER BY sort_order ASC`)
      .all(plan.id) as Array<{
      id: string
      title: string
      description: string
      success_criteria: string
      confirmed: number
    }>

    const tree: ExecutionTreeSnapshot = {
      treeId: plan.id,
      planningSessionId: sessionId,
      revision: plan.revision,
      milestones: milestones.map((m) => {
        const slices = this.db
          .prepare(
            `SELECT * FROM execution_plan_slices WHERE plan_id = ? AND milestone_id = ? ORDER BY sort_order ASC`
          )
          .all(plan.id, m.id) as Array<{
          id: string
          title: string
          description: string
          success_criteria: string
          confirmed: number
        }>
        return {
          id: m.id,
          title: m.title,
          description: m.description,
          successCriteria: m.success_criteria,
          confirmed: m.confirmed === 1,
          slices: slices.map((s) => {
            const tasks = this.db
              .prepare(
                `SELECT * FROM execution_plan_tasks WHERE plan_id = ? AND slice_id = ? ORDER BY sort_order ASC`
              )
              .all(plan.id, s.id) as Array<{
              id: string
              title: string
              description: string
              task_kind: string
              ability_code: string
              core_code: string
              context_markdown: string
              success_criteria: string
              can_run_in_parallel: number
              confirmed: number
            }>
            return {
              id: s.id,
              milestoneId: m.id,
              title: s.title,
              description: s.description,
              successCriteria: s.success_criteria,
              confirmed: s.confirmed === 1,
              tasks: tasks.map((t) => {
                const refs = this.db
                  .prepare(
                    `SELECT reference_id FROM execution_plan_task_references WHERE plan_id = ? AND task_id = ?`
                  )
                  .all(plan.id, t.id) as Array<{ reference_id: string }>
                const deps = this.db
                  .prepare(
                    `SELECT from_node_id FROM execution_plan_dependencies
                     WHERE plan_id = ? AND to_node_id = ? AND dependency_kind = 'task'`
                  )
                  .all(plan.id, t.id) as Array<{ from_node_id: string }>
                return {
                  id: t.id,
                  sliceId: s.id,
                  title: t.title,
                  description: t.description,
                  taskKind: t.task_kind,
                  abilityCode: t.ability_code,
                  coreCode: t.core_code,
                  contextMarkdown: t.context_markdown,
                  successCriteria: t.success_criteria,
                  referenceIds: refs.map((r) => r.reference_id),
                  dependsOnTaskIds: deps.map((d) => d.from_node_id),
                  canRunInParallel: t.can_run_in_parallel === 1,
                  confirmed: t.confirmed === 1
                }
              })
            }
          })
        }
      })
    }
    return tree
  }

  async insertHandoff(input: {
    submissionId: string
    planningSessionId: string
    idempotencyKey: string
    payloadJson: string
    createdAt: number
  }): Promise<{ created: boolean; existingJobId: string | null }> {
    const existing = this.db
      .prepare(`SELECT submission_id, job_id, status FROM job_handoffs WHERE idempotency_key = ?`)
      .get(input.idempotencyKey) as
      | { submission_id: string; job_id: string | null; status: string }
      | undefined
    if (existing) {
      return { created: false, existingJobId: existing.job_id }
    }
    this.db
      .prepare(
        `INSERT INTO job_handoffs (
          submission_id, planning_session_id, idempotency_key, payload_json,
          status, job_id, attempts, last_error_json, created_at, accepted_at
        ) VALUES (?, ?, ?, ?, 'pending', NULL, 0, NULL, ?, NULL)`
      )
      .run(
        input.submissionId,
        input.planningSessionId,
        input.idempotencyKey,
        input.payloadJson,
        input.createdAt
      )
    return { created: true, existingJobId: null }
  }

  async markHandoffAccepted(input: {
    submissionId: string
    jobId: string
    acceptedAt: number
  }): Promise<void> {
    this.db
      .prepare(
        `UPDATE job_handoffs SET status = 'accepted', job_id = ?, accepted_at = ?, attempts = attempts + 1
         WHERE submission_id = ?`
      )
      .run(input.jobId, input.acceptedAt, input.submissionId)
  }

  async findHandoffByIdempotency(key: string): Promise<{
    submissionId: string
    status: string
    jobId: string | null
    payloadJson: string
  } | null> {
    const row = this.db
      .prepare(
        `SELECT submission_id, status, job_id, payload_json FROM job_handoffs WHERE idempotency_key = ?`
      )
      .get(key) as
      | {
          submission_id: string
          status: string
          job_id: string | null
          payload_json: string
        }
      | undefined
    if (!row) return null
    return {
      submissionId: row.submission_id,
      status: row.status,
      jobId: row.job_id,
      payloadJson: row.payload_json
    }
  }

  private mapSession(row: SessionRow): PlanningSessionRecord {
    return {
      id: row.id,
      actorId: row.actor_id,
      projectId: row.project_id,
      sourceDraftId: row.source_draft_id,
      draftSnapshotJson: row.draft_snapshot_json,
      referenceSnapshotId: row.reference_snapshot_id,
      executionProfile: parseJson(row.execution_profile_json),
      plannerSettingsSnapshotJson: row.planner_settings_snapshot_json,
      plannerSettingsHash: row.planner_settings_hash,
      status: row.status,
      activeRunId: row.active_run_id,
      treeRevision: row.tree_revision,
      publishedJobId: row.published_job_id,
      lastErrorJson: row.last_error_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedAt: row.published_at
    }
  }
}

void stableHash
