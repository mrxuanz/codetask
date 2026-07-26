import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { applyCoreSchema } from '../migrate-core'
import { validateCoreDb } from '../data-validator'
import { mapLegacyJobStatus } from './map-status'
import {
  UnmappableLegacyRowError,
  type MigrateLegacyToCoreInput,
  type MigrationCounts,
  type MigrationReport
} from './types'

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok: number } | undefined
  return row !== undefined
}

function requireMappedId(value: unknown, label: string, row: Record<string, unknown>): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UnmappableLegacyRowError(`Unmappable legacy row: missing ${label}`, { row, label })
  }
  return value
}

function stableHash(parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  hash.update('\n')
  return hash.digest('hex')
}

/**
 * Offline migrator skeleton: copy source → temp work DB, map into a fresh
 * target core DB. Does not mutate the live source in place.
 *
 * Mapping is best-effort stubs for projects/threads/drafts/plans/jobs/tasks.
 * Unmappable rows throw {@link UnmappableLegacyRowError} (no silent drop).
 *
 * TODO: expand draft payload mapping beyond thread_messages kind=draft stubs.
 * TODO: map plan_nodes / plan_edges from design_plan_revisions gzip content.
 * TODO: map task_attempts / verification_attempts / artifacts / outbox.
 */
export function migrateLegacyToCore(input: MigrateLegacyToCoreInput): MigrationReport {
  if (!existsSync(input.sourcePath)) {
    throw new UnmappableLegacyRowError(`Source database not found: ${input.sourcePath}`)
  }

  mkdirSync(dirname(input.targetPath), { recursive: true })
  if (existsSync(input.targetPath)) {
    unlinkSync(input.targetPath)
  }

  const tempSource = join(
    tmpdir(),
    `codetask-core-migrate-${process.pid}-${Date.now()}.sqlite`
  )
  copyFileSync(input.sourcePath, tempSource)

  const source = new Database(tempSource, { readonly: true, fileMustExist: true })
  const target = new Database(input.targetPath)
  target.pragma('foreign_keys = ON')

  try {
    applyCoreSchema(target)

    const projectIds = new Set<string>()
    const threadIds = new Set<string>()
    const draftIds: string[] = []
    const planIds: string[] = []
    const jobIds: string[] = []
    const taskIds: string[] = []

    // --- projects (id set only; no core_projects table yet) ---
    if (tableExists(source, 'projects')) {
      const projects = source
        .prepare(`SELECT id, username, title, created_at, updated_at FROM projects`)
        .all() as Array<{
        id: string
        username: string
        title: string
        created_at: number
        updated_at: number
      }>
      for (const project of projects) {
        const id = requireMappedId(project.id, 'projects.id', project)
        if (!project.username) {
          throw new UnmappableLegacyRowError('Unmappable project: missing username', {
            row: project
          })
        }
        projectIds.add(id)
      }
    }

    // --- threads ---
    if (tableExists(source, 'threads')) {
      const threads = source
        .prepare(
          `SELECT id, username, project_id, title, status, active_draft_id, active_plan_id,
                  created_at, updated_at
           FROM threads`
        )
        .all() as Array<{
        id: string
        username: string
        project_id: string
        title: string
        status: string
        active_draft_id: string | null
        active_plan_id: string | null
        created_at: number
        updated_at: number
      }>

      const insert = target.prepare(
        `INSERT INTO core_threads(
           id, project_id, owner_user_id, status, revision, draft_id, plan_id, job_id,
           title, payload_json, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?, '{}', ?, ?)`
      )

      for (const thread of threads) {
        const id = requireMappedId(thread.id, 'threads.id', thread)
        const projectId = requireMappedId(thread.project_id, 'threads.project_id', thread)
        if (projectIds.size > 0 && !projectIds.has(projectId)) {
          throw new UnmappableLegacyRowError('Unmappable thread: project_id not in projects', {
            row: thread
          })
        }
        if (!thread.username) {
          throw new UnmappableLegacyRowError('Unmappable thread: missing username', { row: thread })
        }
        insert.run(
          id,
          projectId,
          thread.username,
          thread.status || 'active',
          thread.active_draft_id,
          thread.active_plan_id,
          thread.title ?? null,
          thread.created_at ?? 0,
          thread.updated_at ?? 0
        )
        threadIds.add(id)
        projectIds.add(projectId)
      }
    }

    // --- drafts (stub: thread_messages with kind = 'draft' or payload type) ---
    if (tableExists(source, 'thread_messages')) {
      const drafts = source
        .prepare(
          `SELECT id, thread_id, username, kind, content, payload_json, created_at
           FROM thread_messages
           WHERE kind = 'draft' OR kind = 'task_draft'`
        )
        .all() as Array<{
        id: string
        thread_id: string
        username: string
        kind: string
        content: string
        payload_json: string | null
        created_at: string | number
      }>

      const insert = target.prepare(
        `INSERT INTO core_drafts(
           id, project_id, thread_id, status, revision, content, payload_json,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, 'collecting', 0, ?, ?, ?, ?)`
      )

      for (const draft of drafts) {
        const id = requireMappedId(draft.id, 'thread_messages.id', draft)
        const threadId = requireMappedId(draft.thread_id, 'thread_messages.thread_id', draft)
        if (!threadIds.has(threadId)) {
          throw new UnmappableLegacyRowError('Unmappable draft: thread_id not migrated', {
            row: draft
          })
        }
        const thread = target
          .prepare(`SELECT project_id FROM core_threads WHERE id = ?`)
          .get(threadId) as { project_id: string }
        const createdAtMs =
          typeof draft.created_at === 'number'
            ? draft.created_at
            : Date.parse(String(draft.created_at)) || 0
        insert.run(
          id,
          thread.project_id,
          threadId,
          draft.content ?? '',
          draft.payload_json ?? '{}',
          createdAtMs,
          createdAtMs
        )
        draftIds.push(id)
      }
    }

    // --- plans (stub: one core_plans row per active_plan_id / design session job) ---
    // TODO: expand from design_plan_revisions + job plan JSON into nodes/edges.
    if (tableExists(source, 'thread_jobs')) {
      const planJobs = source
        .prepare(
          `SELECT id, thread_id, status, plan_revision, draft_message_id, created_at, updated_at
           FROM thread_jobs
           WHERE plan_confirmed_at IS NOT NULL
              OR COALESCE(plan_revision, 0) > 0
              OR status LIKE 'plan%'`
        )
        .all() as Array<{
        id: string
        thread_id: string
        status: string
        plan_revision: number
        draft_message_id: string
        created_at: number
        updated_at: number
      }>

      const insert = target.prepare(
        `INSERT INTO core_plans(
           id, project_id, thread_id, draft_id, status, revision, execution_generation,
           payload_json, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, 'editing', ?, 1, '{}', ?, ?)`
      )

      for (const job of planJobs) {
        const id = requireMappedId(job.id, 'thread_jobs.id(plan)', job)
        const threadId = requireMappedId(job.thread_id, 'thread_jobs.thread_id', job)
        if (!threadIds.has(threadId)) {
          throw new UnmappableLegacyRowError('Unmappable plan: thread_id not migrated', {
            row: job
          })
        }
        const thread = target
          .prepare(`SELECT project_id FROM core_threads WHERE id = ?`)
          .get(threadId) as { project_id: string }
        insert.run(
          id,
          thread.project_id,
          threadId,
          job.draft_message_id ?? null,
          job.plan_revision ?? 0,
          job.created_at ?? 0,
          job.updated_at ?? 0
        )
        planIds.push(id)
      }
    }

    // --- jobs + tasks ---
    if (tableExists(source, 'thread_jobs')) {
      const jobs = source
        .prepare(
          `SELECT id, thread_id, status, plan_revision, created_at, updated_at, terminal_at
           FROM thread_jobs`
        )
        .all() as Array<{
        id: string
        thread_id: string
        status: string
        plan_revision: number
        created_at: number
        updated_at: number
        terminal_at: number | null
      }>

      const insertJob = target.prepare(
        `INSERT INTO core_jobs(
           id, project_id, thread_id, plan_id, status, revision, plan_revision,
           execution_generation, payload_json, created_at_ms, updated_at_ms, terminal_at_ms
         ) VALUES (?, ?, ?, ?, ?, 0, ?, 1, '{}', ?, ?, ?)`
      )

      for (const job of jobs) {
        const id = requireMappedId(job.id, 'thread_jobs.id', job)
        const threadId = requireMappedId(job.thread_id, 'thread_jobs.thread_id', job)
        if (!threadIds.has(threadId)) {
          throw new UnmappableLegacyRowError('Unmappable job: thread_id not migrated', {
            row: job
          })
        }
        if (!job.status) {
          throw new UnmappableLegacyRowError('Unmappable job: missing status', { row: job })
        }
        const mappedStatus = mapLegacyJobStatus(job.status)
        const thread = target
          .prepare(`SELECT project_id FROM core_threads WHERE id = ?`)
          .get(threadId) as { project_id: string }
        insertJob.run(
          id,
          thread.project_id,
          threadId,
          planIds.includes(id) ? id : null,
          mappedStatus,
          job.plan_revision ?? 1,
          job.created_at ?? 0,
          job.updated_at ?? 0,
          job.terminal_at ?? null
        )
        jobIds.push(id)
      }
    }

    if (tableExists(source, 'job_tasks')) {
      const tasks = source
        .prepare(
          `SELECT job_id, task_id, title, status, sort_order FROM job_tasks`
        )
        .all() as Array<{
        job_id: string
        task_id: string
        title: string
        status: string
        sort_order: number
      }>

      const insert = target.prepare(
        `INSERT INTO core_tasks(
           id, project_id, job_id, plan_node_id, status, revision, title,
           dependency_ids_json, payload_json, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, NULL, ?, 0, ?, '[]', ?, ?, ?)`
      )

      for (const task of tasks) {
        const jobId = requireMappedId(task.job_id, 'job_tasks.job_id', task)
        const taskId = requireMappedId(task.task_id, 'job_tasks.task_id', task)
        if (!jobIds.includes(jobId)) {
          throw new UnmappableLegacyRowError('Unmappable task: job_id not migrated', {
            row: task
          })
        }
        const job = target
          .prepare(`SELECT project_id FROM core_jobs WHERE id = ?`)
          .get(jobId) as { project_id: string }
        const now = Date.now()
        insert.run(
          taskId,
          job.project_id,
          jobId,
          task.status || 'pending',
          task.title ?? null,
          JSON.stringify({ sortOrder: task.sort_order }),
          now,
          now
        )
        taskIds.push(taskId)
      }
    }

    const validation = validateCoreDb(target)
    if (!validation.ok) {
      throw new UnmappableLegacyRowError('Post-migration validation failed: orphans present', {
        orphans: validation.orphans
      })
    }

    const counts: MigrationCounts = {
      projects: projectIds.size,
      threads: threadIds.size,
      drafts: draftIds.length,
      plans: planIds.length,
      jobs: jobIds.length,
      tasks: taskIds.length
    }

    const hash = stableHash([
      `projects=${counts.projects}`,
      `threads=${[...threadIds].sort().join(',')}`,
      `drafts=${[...draftIds].sort().join(',')}`,
      `plans=${[...planIds].sort().join(',')}`,
      `jobs=${[...jobIds].sort().join(',')}`,
      `tasks=${[...taskIds].sort().join(',')}`
    ])

    return {
      counts,
      hash,
      sourcePath: input.sourcePath,
      targetPath: input.targetPath
    }
  } finally {
    source.close()
    target.close()
    try {
      unlinkSync(tempSource)
    } catch {
      // best-effort temp cleanup
    }
  }
}
