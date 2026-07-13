/**
 * Thin compatibility wrappers around job-plan.ts.
 * Design-session plan storage was unified into thread_jobs / job_plan_* tables.
 */
import type { getDb } from './index'
import type { PlanProgressDto, ThreadJobAbilityDto } from '../legacy-control-plane/types'
import type { SavedJobPlan } from '../planner/plan-types'
import {
  loadJobAbilities,
  loadJobPlan,
  loadPlanProgress,
  saveJobAbilities,
  saveJobPlan,
  saveJobPlanInTx,
  savePlanProgress
} from './job-plan'

type AppDatabase = ReturnType<typeof getDb>

export async function loadDesignAbilities(
  db: AppDatabase,
  designSessionId: string
): Promise<ThreadJobAbilityDto[]> {
  return loadJobAbilities(db, designSessionId)
}

export async function saveDesignAbilities(
  db: AppDatabase,
  designSessionId: string,
  abilities: ThreadJobAbilityDto[]
): Promise<void> {
  return saveJobAbilities(db, designSessionId, abilities)
}

export async function loadDesignPlan(
  db: AppDatabase,
  designSessionId: string
): Promise<SavedJobPlan | null> {
  return loadJobPlan(db, designSessionId)
}

export function saveDesignPlanInTx(
  db: AppDatabase,
  designSessionId: string,
  plan: SavedJobPlan | null
): void {
  saveJobPlanInTx(db, designSessionId, plan)
}

export async function saveDesignPlan(
  db: AppDatabase,
  designSessionId: string,
  plan: SavedJobPlan | null
): Promise<void> {
  return saveJobPlan(db, designSessionId, plan)
}

export async function loadDesignPlanProgress(
  db: AppDatabase,
  designSessionId: string
): Promise<PlanProgressDto> {
  return loadPlanProgress(db, designSessionId)
}

export async function saveDesignPlanProgress(
  db: AppDatabase,
  designSessionId: string,
  progress: PlanProgressDto
): Promise<void> {
  return savePlanProgress(db, designSessionId, progress)
}

/** @deprecated Single-row merge: plan already lives on the job; do not copy. */
export async function copyDesignPlanToJob(
  _db: AppDatabase,
  _designSessionId: string,
  _jobId: string
): Promise<void> {
  throw new Error(
    'copyDesignPlanToJob is removed: design sessions and jobs share one thread_jobs row'
  )
}
