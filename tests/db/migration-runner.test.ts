import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { allMigrations } from '../../src/server/db/migrations'
import { currentMigrationVersion, runMigrations } from '../../src/server/db/migrations/runner'

const latestMigrationVersion = allMigrations.at(-1)?.version
if (latestMigrationVersion === undefined) {
  throw new Error('Expected at least one database migration')
}

function seedProjectThreadMessage(db: Database.Database, opts?: { messageId?: string }): void {
  const now = Math.floor(Date.now() / 1000)
  const messageId = opts?.messageId ?? 'msg-1'
  db.prepare(
    `INSERT INTO projects (id, username, title, workspace_root, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('proj-1', 'alice', 'Demo', '/tmp/demo', now, now)
  db.prepare(
    `INSERT INTO threads (
       id, username, project_id, title, status, conversation_id, core_code,
       runtime_status, title_source, wizard_phase, thread_kind, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'thread-1',
    'alice',
    'proj-1',
    'Thread',
    'draft',
    'conv-1',
    'core',
    'idle',
    'auto',
    'collect',
    'chat',
    now,
    now
  )
  db.prepare(
    `INSERT INTO thread_messages (
       id, thread_id, username, role, kind, content, core_code, conversation_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    messageId,
    'thread-1',
    'alice',
    'assistant',
    'task-launch-draft',
    '{}',
    'core',
    'conv-1',
    String(now)
  )
}

/** Minimal design_sessions row for pre-026 migration path (valid at version 16+). */
function seedDesignSession(db: Database.Database): void {
  const now = Math.floor(Date.now() / 1000)
  seedProjectThreadMessage(db)
  db.prepare(
    `INSERT INTO design_sessions (
       id, thread_id, username, draft_message_id, title, workspace_root, status,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('ds-1', 'thread-1', 'alice', 'msg-1', 'Session', '/tmp/demo', 'active', now, now)
}

function seedUnlaunchedDesignSessionWithPlan(db: Database.Database): void {
  const now = Math.floor(Date.now() / 1000)
  seedProjectThreadMessage(db, { messageId: 'msg-unlaunched' })
  db.prepare(
    `INSERT INTO design_sessions (
       id, thread_id, username, draft_message_id, title, summary, workspace_root,
       phase, draft_revision, plan_revision, status, launched_job_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(
    'ds-unlaunched',
    'thread-1',
    'alice',
    'msg-unlaunched',
    'Unlaunched',
    '',
    '/tmp/demo',
    'plan_edit',
    1,
    1,
    'plan_editing',
    now,
    now
  )
  db.prepare(
    `INSERT INTO design_abilities (design_session_id, ability_code, sort_order, label, recommended_core_code)
     VALUES (?, ?, ?, ?, ?)`
  ).run('ds-unlaunched', 'general-implementation', 0, 'General', 'codex')
  db.prepare(
    `INSERT INTO design_plan_milestones
       (design_session_id, milestone_index, sort_order, title, description, success_criteria, confirmed)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('ds-unlaunched', 1, 0, 'M1', '', 'done', 1)
  db.prepare(
    `INSERT INTO design_plan_slices
       (design_session_id, milestone_index, slice_index, sort_order, title, description,
        success_criteria, depends_on_slice_refs_json, confirmed)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  ).run('ds-unlaunched', 1, 1, 0, 'S1', '', 'done', 1)
  db.prepare(
    `INSERT INTO design_plan_tasks
       (design_session_id, task_id, sort_order, milestone_index, slice_index, task_index,
        title, description, task_kind, ability_code, context_markdown, core_code, success_criteria,
        reference_ids_json, reference_reason, depends_on_task_refs_json, can_run_in_parallel, confirmed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, 0, ?)`
  ).run(
    'ds-unlaunched',
    'm1-s1-t1',
    0,
    1,
    1,
    1,
    'T1',
    'd',
    'general-implementation',
    'general-implementation',
    'ctx',
    'done',
    1
  )
}

function seedLaunchedDesignSessionPair(db: Database.Database): void {
  const now = Math.floor(Date.now() / 1000)
  seedProjectThreadMessage(db, { messageId: 'msg-launched' })
  db.prepare(
    `INSERT INTO thread_jobs (
       id, thread_id, username, draft_message_id, title, summary, status, workspace_path,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'job-launched',
    'thread-1',
    'alice',
    'msg-launched',
    'Launched Job',
    '',
    'pending',
    '/tmp/demo',
    now,
    now
  )
  db.prepare(
    `INSERT INTO design_sessions (
       id, thread_id, username, draft_message_id, title, summary, workspace_root,
       phase, draft_revision, plan_revision, status, launched_job_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'ds-launched',
    'thread-1',
    'alice',
    'msg-launched',
    'Launched Session',
    '',
    '/tmp/demo',
    'archived',
    2,
    3,
    'plan_editing',
    'job-launched',
    now,
    now
  )
  // Set pointers after design_sessions exists (plan-pointer triggers validate FK targets).
  db.prepare(`UPDATE threads SET active_plan_id = ? WHERE id = ?`).run('ds-launched', 'thread-1')
  db.prepare(`UPDATE thread_messages SET payload_json = ? WHERE id = ?`).run(
    JSON.stringify({ linkedPlanId: 'ds-launched' }),
    'msg-launched'
  )
  db.prepare(
    `INSERT INTO design_abilities (design_session_id, ability_code, sort_order, label, recommended_core_code)
     VALUES (?, ?, ?, ?, ?)`
  ).run('ds-launched', 'general-implementation', 0, 'General', 'codex')
  db.prepare(
    `INSERT INTO draft_references (
       id, design_session_id, source, name, kind, description, sort_order, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('ref-launched', 'ds-launched', 'attachment', 'ref', 'image', '', 0, now, now)
}

function seedWorkloadDesignSessionOwner(db: Database.Database): void {
  const now = Math.floor(Date.now() / 1000)
  seedProjectThreadMessage(db, { messageId: 'msg-wl' })
  db.prepare(
    `INSERT INTO design_sessions (
       id, thread_id, username, draft_message_id, title, workspace_root, status,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('ds-wl', 'thread-1', 'alice', 'msg-wl', 'WL', '/tmp/demo', 'planning', now, now)
  db.prepare(
    `INSERT INTO workload_runs (
       id, username, owner_kind, owner_id, kind, pool, status, started_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('run-wl', 'alice', 'design_session', 'ds-wl', 'planner', 'default', 'active', now, now)
  db.prepare(
    `INSERT INTO workload_slots (
       run_id, username, pool, owner_kind, owner_id, kind, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('run-wl', 'alice', 'default', 'design_session', 'ds-wl', 'planner', 'active', now)
}

test('migrations apply through latest version on empty database', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db, allMigrations)
  assert.equal(currentMigrationVersion(db), latestMigrationVersion)
  db.close()
})

test('migration 017 succeeds when design_sessions references threads (FK on)', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  const through16 = allMigrations.filter((m) => m.version <= 16)
  runMigrations(db, through16)
  seedDesignSession(db)
  assert.equal(currentMigrationVersion(db), 16)

  runMigrations(db, allMigrations)
  assert.equal(currentMigrationVersion(db), latestMigrationVersion)
  const wizardPhase = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'threads'`)
    .get() as { sql: string }
  assert.match(wizardPhase.sql, /plan_generating/)
  db.close()
})

test('migration 026 empty DB has no design_sessions and thread_jobs design columns', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db, allMigrations)
  assert.equal(currentMigrationVersion(db), latestMigrationVersion)

  const designSessions = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'design_sessions'`)
    .get()
  assert.equal(designSessions, undefined)

  const cols = db.prepare(`PRAGMA table_info(thread_jobs)`).all() as Array<{ name: string }>
  const names = new Set(cols.map((col) => col.name))
  assert.ok(names.has('phase'))
  assert.ok(names.has('plan_revision'))
  assert.ok(names.has('draft_revision'))
  assert.ok(names.has('manifest_revision'))
  assert.ok(names.has('corpus_revision'))
  assert.ok(names.has('frozen_corpus_revision'))
  assert.ok(names.has('plan_artifact_id'))
  assert.ok(names.has('plan_summary_json'))
  db.close()
})

test('migration 026 moves unlaunched design_session into thread_jobs and drops design_sessions', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  const through25 = allMigrations.filter((m) => m.version <= 25)
  runMigrations(db, through25)
  assert.equal(currentMigrationVersion(db), 25)

  seedUnlaunchedDesignSessionWithPlan(db)
  runMigrations(db, allMigrations)
  assert.equal(currentMigrationVersion(db), latestMigrationVersion)

  const job = db.prepare(`SELECT * FROM thread_jobs WHERE id = ?`).get('ds-unlaunched') as
    | Record<string, unknown>
    | undefined
  assert.ok(job)
  assert.equal(job.status, 'plan_editing')
  assert.equal(job.workspace_path, '/tmp/demo')
  assert.equal(job.phase, 'plan_edit')
  assert.equal(job.draft_revision, 1)
  assert.equal(job.plan_revision, 1)

  const ability = db
    .prepare(`SELECT ability_code FROM job_abilities WHERE job_id = ?`)
    .get('ds-unlaunched') as { ability_code: string } | undefined
  assert.equal(ability?.ability_code, 'general-implementation')

  const planTask = db
    .prepare(`SELECT task_id FROM job_plan_tasks WHERE job_id = ?`)
    .get('ds-unlaunched') as { task_id: string } | undefined
  assert.equal(planTask?.task_id, 'm1-s1-t1')

  const designSessions = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'design_sessions'`)
    .get()
  assert.equal(designSessions, undefined)
  db.close()
})

test('migration 026 enriches launched job and rewrites plan pointers', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  const through25 = allMigrations.filter((m) => m.version <= 25)
  runMigrations(db, through25)

  seedLaunchedDesignSessionPair(db)
  runMigrations(db, allMigrations)
  assert.equal(currentMigrationVersion(db), latestMigrationVersion)

  const job = db.prepare(`SELECT * FROM thread_jobs WHERE id = ?`).get('job-launched') as
    | Record<string, unknown>
    | undefined
  assert.ok(job)
  assert.equal(job.phase, 'archived')
  assert.equal(job.draft_revision, 2)
  assert.equal(job.plan_revision, 3)
  assert.equal(job.design_session_id, 'ds-launched')

  const thread = db.prepare(`SELECT active_plan_id FROM threads WHERE id = ?`).get('thread-1') as {
    active_plan_id: string | null
  }
  assert.equal(thread.active_plan_id, 'job-launched')

  const msg = db
    .prepare(
      `SELECT json_extract(payload_json, '$.linkedPlanId') AS linked FROM thread_messages WHERE id = ?`
    )
    .get('msg-launched') as { linked: string }
  assert.equal(msg.linked, 'job-launched')

  const ref = db
    .prepare(`SELECT design_session_id FROM draft_references WHERE id = ?`)
    .get('ref-launched') as { design_session_id: string }
  assert.equal(ref.design_session_id, 'job-launched')

  const designSessions = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'design_sessions'`)
    .get()
  assert.equal(designSessions, undefined)

  const dsJob = db.prepare(`SELECT 1 FROM thread_jobs WHERE id = ?`).get('ds-launched')
  assert.equal(dsJob, undefined)
  db.close()
})

test('migration 026 rewrites workload owner_kind design_session to thread_job', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  const through25 = allMigrations.filter((m) => m.version <= 25)
  runMigrations(db, through25)

  seedWorkloadDesignSessionOwner(db)
  runMigrations(db, allMigrations)
  assert.equal(currentMigrationVersion(db), latestMigrationVersion)

  const run = db
    .prepare(`SELECT owner_kind, owner_id FROM workload_runs WHERE id = ?`)
    .get('run-wl') as {
    owner_kind: string
    owner_id: string
  }
  assert.equal(run.owner_kind, 'thread_job')
  assert.equal(run.owner_id, 'ds-wl')

  const slot = db
    .prepare(`SELECT owner_kind, owner_id FROM workload_slots WHERE run_id = ?`)
    .get('run-wl') as { owner_kind: string; owner_id: string }
  assert.equal(slot.owner_kind, 'thread_job')
  assert.equal(slot.owner_id, 'ds-wl')
  db.close()
})
