import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Migration } from './v001_042/types.ts'

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

function recordFailure(
  db: Database.Database,
  sourceKey: string,
  reason: string,
  payload: unknown
): void {
  db.prepare(
    `INSERT INTO migration_failures (id, migration_name, source_key, reason, payload_json, created_at)
     VALUES (?, '044_design_data_backfill', ?, ?, ?, ?)`
  ).run(randomUUID(), sourceKey, reason, JSON.stringify(payload), Date.now())
}

/**
 * Idempotent Design data backfill from legacy message payloads / design thread_jobs.
 * Failures are recorded; applyMigrations callers should block if migration_failures exist.
 */
export const migration044DesignDataBackfill: Migration = {
  version: 44,
  name: 'design_data_backfill',
  up(db) {
    const marker = db
      .prepare(
        `SELECT 1 AS ok FROM schema_migrations WHERE version = 44 AND name = 'design_data_backfill'`
      )
      .get() as { ok: number } | undefined
    // Runner records schema_migrations after up(); use a local marker table for idempotency of rows.
    db.exec(`
      CREATE TABLE IF NOT EXISTS design_backfill_markers (
        source_key TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)

    const messages = db
      .prepare(
        `SELECT m.id AS message_id, m.thread_id, m.username, m.payload_json, m.created_at,
                t.project_id, p.workspace_root AS workspace_path
         FROM thread_messages m
         JOIN threads t ON t.id = m.thread_id
         JOIN projects p ON p.id = t.project_id
         WHERE m.kind = 'task-launch-draft'`
      )
      .all() as Array<{
      message_id: string
      thread_id: string
      username: string
      payload_json: string
      created_at: string | number
      project_id: string
      workspace_path: string
    }>

    void marker

    function toMs(value: string | number | null | undefined): number {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 1_000_000_000_000 ? value * 1000 : value
      }
      if (typeof value === 'string' && value.trim()) {
        const asNum = Number(value)
        if (Number.isFinite(asNum)) {
          return asNum < 1_000_000_000_000 ? asNum * 1000 : asNum
        }
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
      }
      return Date.now()
    }

    const insertDraft = db.prepare(
      `INSERT OR IGNORE INTO drafts (
        id, actor_id, project_id, title, summary, user_flow, tech_stack,
        nfr_json, acceptance_json, verification_json, out_of_scope_json, assumptions_json,
        requirements_markdown, requirements_status, locked_sections_json, execution_profile_json,
        workspace_root, status, lock_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertAbility = db.prepare(
      `INSERT OR IGNORE INTO draft_abilities (
        draft_id, ability_code, label, description, reason, recommended_core_code, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const insertRef = db.prepare(
      `INSERT OR IGNORE INTO design_draft_references (
        id, draft_id, source, name, kind, mime_type, description,
        attachment_id, local_path, resolved_path, asset_url, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    for (const row of messages) {
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>
        const draftId =
          typeof payload.draftId === 'string' && payload.draftId
            ? payload.draftId
            : `draft_migrated_${hash(row.message_id)}`
        const title = String(payload.title ?? 'Untitled draft')
        const status =
          payload.status === 'confirmed' || payload.status === 'archived'
            ? payload.status
            : 'editing'
        const requirements =
          payload.requirementsContract && typeof payload.requirementsContract === 'object'
            ? (payload.requirementsContract as { markdown?: string; status?: string })
            : { markdown: '', status: 'pending' }
        const executionConfig =
          payload.executionConfig && typeof payload.executionConfig === 'object'
            ? payload.executionConfig
            : null

        insertDraft.run(
          draftId,
          row.username,
          row.project_id,
          title,
          String(payload.summary ?? ''),
          String(payload.userFlow ?? ''),
          String(payload.techStack ?? ''),
          JSON.stringify(payload.nfr ?? []),
          JSON.stringify(payload.acceptance ?? []),
          JSON.stringify(payload.verification ?? []),
          JSON.stringify(payload.outOfScope ?? []),
          JSON.stringify(payload.assumptions ?? []),
          String(requirements.markdown ?? ''),
          requirements.status === 'confirmed' ? 'confirmed' : 'pending',
          JSON.stringify(payload.lockedSections ?? {}),
          executionConfig ? JSON.stringify(executionConfig) : null,
          row.workspace_path,
          status,
          typeof payload.revision === 'number' ? payload.revision : 0,
          toMs(row.created_at),
          toMs(row.created_at)
        )

        const abilities = Array.isArray(payload.abilities) ? payload.abilities : []
        abilities.forEach((ability: unknown, index: number) => {
          if (!ability || typeof ability !== 'object') return
          const a = ability as Record<string, unknown>
          if (typeof a.abilityCode !== 'string') return
          insertAbility.run(
            draftId,
            a.abilityCode,
            String(a.label ?? a.abilityCode),
            String(a.description ?? ''),
            String(a.reason ?? ''),
            String(a.recommendedCoreCode ?? 'opencode'),
            index
          )
        })

        const references = Array.isArray(payload.references) ? payload.references : []
        references.forEach((reference: unknown, index: number) => {
          if (!reference || typeof reference !== 'object') return
          const r = reference as Record<string, unknown>
          const id = typeof r.id === 'string' ? r.id : `ref_${hash(`${draftId}:${index}`)}`
          insertRef.run(
            id,
            draftId,
            typeof r.source === 'string' ? r.source : null,
            String(r.name ?? id),
            String(r.kind ?? 'file'),
            typeof r.mimeType === 'string' ? r.mimeType : null,
            String(r.description ?? ''),
            null,
            typeof r.localPath === 'string' ? r.localPath : null,
            null,
            typeof r.assetUrl === 'string' ? r.assetUrl : null,
            index,
            Date.now(),
            Date.now()
          )
        })
      } catch (error) {
        recordFailure(db, row.message_id, error instanceof Error ? error.message : String(error), {
          messageId: row.message_id
        })
      }
    }

    const designJobs = db
      .prepare(
        `SELECT id, username, title, summary, workspace_path, status, phase,
                execution_profile_json, draft_message_id, design_session_id,
                plan_revision, created_at, updated_at
         FROM thread_jobs
         WHERE phase IN ('plan_generating', 'plan_editing', 'draft_review')
            OR status IN ('planning', 'plan_editing')`
      )
      .all() as Array<{
      id: string
      username: string
      title: string
      summary: string
      workspace_path: string
      status: string
      phase: string | null
      execution_profile_json: string | null
      draft_message_id: string
      design_session_id: string | null
      plan_revision: number
      created_at: number
      updated_at: number
    }>

    const insertSession = db.prepare(
      `INSERT OR IGNORE INTO planning_sessions (
        id, actor_id, project_id, source_draft_id, draft_snapshot_json, reference_snapshot_id,
        execution_profile_json, planner_settings_snapshot_json, planner_settings_hash,
        status, active_run_id, tree_revision, published_job_id, last_error_json,
        created_at, updated_at, published_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, '{}', '', ?, NULL, ?, NULL, NULL, ?, ?, NULL)`
    )

    for (const job of designJobs) {
      try {
        const msg = db
          .prepare(`SELECT payload_json FROM thread_messages WHERE id = ?`)
          .get(job.draft_message_id) as { payload_json: string } | undefined
        if (!msg) {
          recordFailure(db, job.id, 'Missing draft message for design job', job)
          continue
        }
        const payload = JSON.parse(msg.payload_json) as Record<string, unknown>
        const draftId =
          typeof payload.draftId === 'string' && payload.draftId
            ? payload.draftId
            : `draft_migrated_${hash(job.draft_message_id)}`
        const draft = db.prepare(`SELECT project_id FROM drafts WHERE id = ?`).get(draftId) as
          | { project_id: string }
          | undefined
        if (!draft) {
          recordFailure(db, job.id, 'Draft not migrated for planning session', {
            draftId,
            jobId: job.id
          })
          continue
        }
        const status =
          job.status === 'plan_editing'
            ? 'plan_editing'
            : job.status === 'planning'
              ? 'planning'
              : 'cancelled'
        insertSession.run(
          job.id,
          job.username,
          draft.project_id,
          draftId,
          JSON.stringify({
            draftId,
            title: job.title,
            summary: job.summary,
            workspaceRoot: job.workspace_path,
            migratedFrom: 'thread_jobs'
          }),
          job.execution_profile_json ??
            JSON.stringify({
              plannerCoreCode: 'opencode',
              sliceVerifierCoreCode: 'opencode',
              milestoneVerifierCoreCode: 'opencode'
            }),
          status,
          job.plan_revision,
          job.created_at * (job.created_at < 1_000_000_000_000 ? 1000 : 1),
          job.updated_at * (job.updated_at < 1_000_000_000_000 ? 1000 : 1)
        )
      } catch (error) {
        recordFailure(db, job.id, error instanceof Error ? error.message : String(error), {
          jobId: job.id
        })
      }
    }
  }
}
