import type { Migration } from './types'
import { JOB_EVENT_TYPES, PLAN_PHASES, PLAN_STATUSES, sqlInList } from '../constraints'
import { createThreadPlanPointerTriggers } from './thread-plan-pointer-triggers'

function tableExists(db: import('better-sqlite3').Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

function columnExists(
  db: import('better-sqlite3').Database,
  table: string,
  column: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((col) => col.name === column)
}

function addThreadJobsPlanColumns(db: import('better-sqlite3').Database): void {
  const adds: Array<[string, string]> = [
    [
      'plan_phase',
      `TEXT NOT NULL DEFAULT 'idle' CHECK (plan_phase IN (${sqlInList(PLAN_PHASES)}))`
    ],
    [
      'plan_status',
      `TEXT NOT NULL DEFAULT 'pending' CHECK (plan_status IN (${sqlInList(PLAN_STATUSES)}))`
    ],
    ['plan_contexts_registered', 'INTEGER NOT NULL DEFAULT 0'],
    ['plan_contexts_total', 'INTEGER NOT NULL DEFAULT 0'],
    ['plan_message', 'TEXT'],
    ['plan_counts_json', `TEXT NOT NULL DEFAULT '{}'`],
    ['plan_milestones_json', 'TEXT']
  ]

  for (const [name, definition] of adds) {
    if (!columnExists(db, 'thread_jobs', name)) {
      db.exec(`ALTER TABLE thread_jobs ADD COLUMN ${name} ${definition}`)
    }
  }
}

function migratePlanAndAbilitiesFromJson(db: import('better-sqlite3').Database): void {
  const jobs = db
    .prepare(`SELECT id, abilities_json, plan_json, plan_progress_json FROM thread_jobs`)
    .all() as Array<{
    id: string
    abilities_json: string
    plan_json: string | null
    plan_progress_json: string
  }>

  const updatePlanProgress = db.prepare(`
    UPDATE thread_jobs SET
      plan_phase = ?,
      plan_status = ?,
      plan_contexts_registered = ?,
      plan_contexts_total = ?,
      plan_message = ?,
      plan_counts_json = ?,
      plan_milestones_json = ?
    WHERE id = ?
  `)

  const insertAbility = db.prepare(`
    INSERT OR REPLACE INTO job_abilities (
      job_id, ability_code, sort_order, label, recommended_core_code
    ) VALUES (?, ?, ?, ?, ?)
  `)

  const insertPlanTask = db.prepare(`
    INSERT OR REPLACE INTO job_plan_tasks (
      job_id, task_id, sort_order, milestone_index, slice_index, task_index,
      title, description, task_kind, ability_code, context_markdown, core_code,
      success_criteria, reference_ids_json, reference_reason,
      depends_on_task_refs_json, can_run_in_parallel, confirmed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const job of jobs) {
    let abilities: Array<Record<string, unknown>> = []
    try {
      abilities = JSON.parse(job.abilities_json || '[]') as Array<Record<string, unknown>>
    } catch {
      abilities = []
    }

    abilities.forEach((ability, index) => {
      const code = typeof ability.abilityCode === 'string' ? ability.abilityCode : null
      if (!code) return
      insertAbility.run(
        job.id,
        code,
        index,
        typeof ability.label === 'string' ? ability.label : null,
        typeof ability.recommendedCoreCode === 'string' ? ability.recommendedCoreCode : null
      )
    })

    let plan: { milestones?: unknown; tasks?: Array<Record<string, unknown>> } | null = null
    if (job.plan_json) {
      try {
        plan = JSON.parse(job.plan_json) as {
          milestones?: unknown
          tasks?: Array<Record<string, unknown>>
        }
      } catch {
        plan = null
      }
    }

    if (plan?.tasks?.length) {
      plan.tasks.forEach((task, index) => {
        const taskId = typeof task.id === 'string' ? task.id : `legacy-plan-${index}`
        insertPlanTask.run(
          job.id,
          taskId,
          index,
          typeof task.milestoneIndex === 'number' ? task.milestoneIndex : 0,
          typeof task.sliceIndex === 'number' ? task.sliceIndex : 0,
          typeof task.taskIndex === 'number' ? task.taskIndex : index,
          typeof task.title === 'string' ? task.title : taskId,
          typeof task.description === 'string' ? task.description : '',
          typeof task.taskKind === 'string' ? task.taskKind : 'task',
          typeof task.abilityCode === 'string' ? task.abilityCode : '',
          typeof task.contextMarkdown === 'string' ? task.contextMarkdown : '',
          typeof task.coreCode === 'string' ? task.coreCode : null,
          typeof task.successCriteria === 'string' ? task.successCriteria : '',
          Array.isArray(task.referenceIds) ? JSON.stringify(task.referenceIds) : null,
          typeof task.referenceReason === 'string' ? task.referenceReason : null,
          Array.isArray(task.dependsOnTaskRefs) ? JSON.stringify(task.dependsOnTaskRefs) : null,
          task.canRunInParallel ? 1 : 0,
          task.confirmed === undefined || task.confirmed === null ? null : task.confirmed ? 1 : 0
        )
      })
    }

    let progress: Record<string, unknown> = {}
    try {
      progress = JSON.parse(job.plan_progress_json || '{}') as Record<string, unknown>
    } catch {
      progress = {}
    }

    const counts = {
      milestones: progress.milestones,
      slices: progress.slices,
      tasks: progress.tasks
    }

    updatePlanProgress.run(
      typeof progress.phase === 'string' ? progress.phase : 'idle',
      typeof progress.status === 'string' ? progress.status : 'pending',
      typeof progress.contextsRegistered === 'number' ? progress.contextsRegistered : 0,
      typeof progress.contextsTotal === 'number' ? progress.contextsTotal : 0,
      typeof progress.message === 'string' ? progress.message : null,
      JSON.stringify(counts),
      plan?.milestones ? JSON.stringify(plan.milestones) : null,
      job.id
    )
  }
}

function createThreadPointerTriggers(db: import('better-sqlite3').Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS threads_active_draft_insert;
    CREATE TRIGGER threads_active_draft_insert
    BEFORE INSERT ON threads
    WHEN NEW.active_draft_id IS NOT NULL
    BEGIN
      SELECT CASE
        WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.active_draft_id) IS NULL
          THEN RAISE(ABORT, 'active_draft_id must reference an existing message')
        WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.active_draft_id) != NEW.id
          THEN RAISE(ABORT, 'active_draft_id must belong to the same thread')
        WHEN (SELECT kind FROM thread_messages WHERE id = NEW.active_draft_id) != 'task-launch-draft'
          THEN RAISE(ABORT, 'active_draft_id must reference a task-launch-draft message')
      END;
    END;

    DROP TRIGGER IF EXISTS threads_active_draft_update;
    CREATE TRIGGER threads_active_draft_update
    BEFORE UPDATE OF active_draft_id ON threads
    WHEN NEW.active_draft_id IS NOT NULL
    BEGIN
      SELECT CASE
        WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.active_draft_id) IS NULL
          THEN RAISE(ABORT, 'active_draft_id must reference an existing message')
        WHEN (SELECT thread_id FROM thread_messages WHERE id = NEW.active_draft_id) != NEW.id
          THEN RAISE(ABORT, 'active_draft_id must belong to the same thread')
        WHEN (SELECT kind FROM thread_messages WHERE id = NEW.active_draft_id) != 'task-launch-draft'
          THEN RAISE(ABORT, 'active_draft_id must reference a task-launch-draft message')
      END;
    END;
  `)
  createThreadPlanPointerTriggers(db)
}

export const migration003PlanAbilitiesEvents: Migration = {
  version: 3,
  name: 'plan_abilities_events',
  up(db) {
    if (tableExists(db, 'job_abilities')) {
      if (tableExists(db, 'thread_jobs')) {
        createThreadPointerTriggers(db)
      }
      return
    }

    addThreadJobsPlanColumns(db)

    db.exec(`
      CREATE TABLE job_abilities (
        job_id TEXT NOT NULL REFERENCES thread_jobs(id) ON DELETE CASCADE,
        ability_code TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        label TEXT,
        recommended_core_code TEXT,
        PRIMARY KEY (job_id, ability_code)
      );

      CREATE INDEX IF NOT EXISTS idx_job_abilities_job_order
        ON job_abilities (job_id, sort_order);

      CREATE TABLE job_plan_tasks (
        job_id TEXT NOT NULL REFERENCES thread_jobs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        milestone_index INTEGER NOT NULL,
        slice_index INTEGER NOT NULL,
        task_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        task_kind TEXT NOT NULL,
        ability_code TEXT NOT NULL,
        context_markdown TEXT NOT NULL DEFAULT '',
        core_code TEXT,
        success_criteria TEXT NOT NULL DEFAULT '',
        reference_ids_json TEXT,
        reference_reason TEXT,
        depends_on_task_refs_json TEXT,
        can_run_in_parallel INTEGER NOT NULL DEFAULT 0,
        confirmed INTEGER,
        PRIMARY KEY (job_id, task_id)
      );

      CREATE INDEX IF NOT EXISTS idx_job_plan_tasks_job_order
        ON job_plan_tasks (job_id, sort_order);

      CREATE TABLE job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES thread_jobs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN (${sqlInList(JOB_EVENT_TYPES)})),
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_job_events_job_created
        ON job_events (job_id, created_at DESC);
    `)

    migratePlanAndAbilitiesFromJson(db)
    createThreadPointerTriggers(db)
  }
}
