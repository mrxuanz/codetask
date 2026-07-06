import type { Migration } from './types'

function tableExists(db: import('better-sqlite3').Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

type MilestoneJson = {
  title?: string
  description?: string
  successCriteria?: string
  confirmed?: boolean
  slices?: Array<{
    title?: string
    description?: string
    successCriteria?: string
    dependsOnSliceRefs?: string[]
    confirmed?: boolean
    tasks?: unknown[]
  }>
}

function migrateMilestonesFromJson(db: import('better-sqlite3').Database): void {
  const jobs = db
    .prepare(
      `SELECT id, plan_milestones_json, plan_json FROM thread_jobs
       WHERE (plan_milestones_json IS NOT NULL AND plan_milestones_json != '')
          OR (plan_json IS NOT NULL AND plan_json != '')`
    )
    .all() as Array<{ id: string; plan_milestones_json: string | null; plan_json: string | null }>

  const insertMilestone = db.prepare(`
    INSERT OR REPLACE INTO job_plan_milestones (
      job_id, milestone_index, sort_order, title, description, success_criteria, confirmed
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const insertSlice = db.prepare(`
    INSERT OR REPLACE INTO job_plan_slices (
      job_id, milestone_index, slice_index, sort_order, title, description,
      success_criteria, depends_on_slice_refs_json, confirmed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const job of jobs) {
    let milestones: MilestoneJson[] = []
    if (job.plan_milestones_json) {
      try {
        milestones = JSON.parse(job.plan_milestones_json) as MilestoneJson[]
      } catch {
        milestones = []
      }
    }
    if (milestones.length === 0 && job.plan_json) {
      try {
        const plan = JSON.parse(job.plan_json) as { milestones?: MilestoneJson[] }
        milestones = Array.isArray(plan.milestones) ? plan.milestones : []
      } catch {
        milestones = []
      }
    }

    milestones.forEach((milestone, mIdx) => {
      insertMilestone.run(
        job.id,
        mIdx,
        mIdx,
        milestone.title ?? '',
        milestone.description ?? '',
        milestone.successCriteria ?? '',
        milestone.confirmed === undefined || milestone.confirmed === null
          ? null
          : milestone.confirmed
            ? 1
            : 0
      )

      const slices = Array.isArray(milestone.slices) ? milestone.slices : []
      slices.forEach((slice, sIdx) => {
        insertSlice.run(
          job.id,
          mIdx,
          sIdx,
          mIdx * 1000 + sIdx,
          slice.title ?? '',
          slice.description ?? '',
          slice.successCriteria ?? '',
          Array.isArray(slice.dependsOnSliceRefs) ? JSON.stringify(slice.dependsOnSliceRefs) : null,
          slice.confirmed === undefined || slice.confirmed === null ? null : slice.confirmed ? 1 : 0
        )
      })
    })
  }
}

export const migration005PlanMilestonesSlices: Migration = {
  version: 5,
  name: 'plan_milestones_slices',
  up(db) {
    if (tableExists(db, 'job_plan_milestones')) return

    db.exec(`
      CREATE TABLE job_plan_milestones (
        job_id TEXT NOT NULL REFERENCES thread_jobs(id) ON DELETE CASCADE,
        milestone_index INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        confirmed INTEGER,
        PRIMARY KEY (job_id, milestone_index)
      );

      CREATE INDEX IF NOT EXISTS idx_job_plan_milestones_job_order
        ON job_plan_milestones (job_id, sort_order);

      CREATE TABLE job_plan_slices (
        job_id TEXT NOT NULL REFERENCES thread_jobs(id) ON DELETE CASCADE,
        milestone_index INTEGER NOT NULL,
        slice_index INTEGER NOT NULL,
        sort_order INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        depends_on_slice_refs_json TEXT,
        confirmed INTEGER,
        PRIMARY KEY (job_id, milestone_index, slice_index)
      );

      CREATE INDEX IF NOT EXISTS idx_job_plan_slices_job_order
        ON job_plan_slices (job_id, sort_order);
    `)

    migrateMilestonesFromJson(db)
  }
}
