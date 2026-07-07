import { asc, eq } from 'drizzle-orm'
import type { getDb } from './index'
import type { PlanProgressDto, ThreadJobAbilityDto } from '../jobs/types'
import { defaultPlanProgress } from '../planner/save-plan'
import type {
  FlatTaskPlan,
  PlannerRegisteredMilestone,
  PlannerRegisteredSlice,
  PlannerRegisteredTask,
  SavedJobPlan
} from '../planner/plan-types'
import {
  designAbilities,
  designPlanMilestones,
  designPlanSlices,
  designPlanTasks,
  designSessions
} from './schema'

type AppDatabase = ReturnType<typeof getDb>

type PlanCounts = {
  milestones?: number
  slices?: number
  tasks?: number
}

function parseJsonArray(value: string | null | undefined): string[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : undefined
  } catch {
    return undefined
  }
}

function parseCounts(value: string | null | undefined): PlanCounts {
  if (!value) return {}
  try {
    return JSON.parse(value) as PlanCounts
  } catch {
    return {}
  }
}

function mapAbilityRow(row: typeof designAbilities.$inferSelect): ThreadJobAbilityDto {
  return {
    abilityCode: row.abilityCode,
    label: row.label ?? undefined,
    recommendedCoreCode: row.recommendedCoreCode ?? undefined
  }
}

function mapPlanTaskRow(row: typeof designPlanTasks.$inferSelect): FlatTaskPlan {
  return {
    id: row.taskId,
    milestoneIndex: row.milestoneIndex,
    sliceIndex: row.sliceIndex,
    taskIndex: row.taskIndex,
    title: row.title,
    description: row.description,
    taskKind: row.taskKind,
    abilityCode: row.abilityCode,
    contextMarkdown: row.contextMarkdown,
    coreCode: row.coreCode ?? undefined,
    successCriteria: row.successCriteria,
    referenceIds: parseJsonArray(row.referenceIdsJson),
    referenceReason: row.referenceReason ?? undefined,
    dependsOnTaskRefs: parseJsonArray(row.dependsOnTaskRefsJson),
    canRunInParallel: row.canRunInParallel === 1,
    confirmed: row.confirmed === null ? undefined : row.confirmed === 1
  }
}

function flatTaskToRegisteredTask(task: FlatTaskPlan): PlannerRegisteredTask {
  return {
    title: task.title,
    description: task.description,
    taskKind: task.taskKind,
    abilityCode: task.abilityCode,
    referenceIds: task.referenceIds,
    referenceReason: task.referenceReason,
    dependsOnTaskRefs: task.dependsOnTaskRefs,
    successCriteria: task.successCriteria,
    canRunInParallel: task.canRunInParallel,
    confirmed: task.confirmed
  }
}

function nestedTasksForSlice(
  flatTasks: FlatTaskPlan[],
  milestoneIndex: number,
  sliceIndex: number
): PlannerRegisteredTask[] {
  return flatTasks
    .filter(
      (task) => task.milestoneIndex === milestoneIndex + 1 && task.sliceIndex === sliceIndex + 1
    )
    .sort((a, b) => a.taskIndex - b.taskIndex)
    .map(flatTaskToRegisteredTask)
}

function assembleMilestones(
  milestoneRows: Array<typeof designPlanMilestones.$inferSelect>,
  sliceRows: Array<typeof designPlanSlices.$inferSelect>,
  flatTasks: FlatTaskPlan[]
): PlannerRegisteredMilestone[] {
  return milestoneRows.map((milestone) => {
    const slices = sliceRows
      .filter((slice) => slice.milestoneIndex === milestone.milestoneIndex)
      .sort((a, b) => a.sliceIndex - b.sliceIndex)
      .map(
        (slice): PlannerRegisteredSlice => ({
          title: slice.title || undefined,
          description: slice.description || undefined,
          successCriteria: slice.successCriteria,
          dependsOnSliceRefs: parseJsonArray(slice.dependsOnSliceRefsJson),
          confirmed: slice.confirmed === null ? undefined : slice.confirmed === 1,
          tasks: nestedTasksForSlice(flatTasks, slice.milestoneIndex, slice.sliceIndex)
        })
      )

    return {
      title: milestone.title || undefined,
      description: milestone.description || undefined,
      successCriteria: milestone.successCriteria || undefined,
      confirmed: milestone.confirmed === null ? undefined : milestone.confirmed === 1,
      slices
    }
  })
}

async function loadPlanMilestonesFromDb(
  db: AppDatabase,
  designSessionId: string,
  flatTasks: FlatTaskPlan[]
): Promise<PlannerRegisteredMilestone[] | null> {
  const milestoneRows = await db
    .select()
    .from(designPlanMilestones)
    .where(eq(designPlanMilestones.designSessionId, designSessionId))
    .orderBy(asc(designPlanMilestones.sortOrder))

  if (milestoneRows.length === 0) return null

  const sliceRows = await db
    .select()
    .from(designPlanSlices)
    .where(eq(designPlanSlices.designSessionId, designSessionId))
    .orderBy(asc(designPlanSlices.sortOrder))

  return assembleMilestones(milestoneRows, sliceRows, flatTasks)
}

async function savePlanMilestones(
  db: AppDatabase,
  designSessionId: string,
  milestones: PlannerRegisteredMilestone[]
): Promise<void> {
  await db.delete(designPlanSlices).where(eq(designPlanSlices.designSessionId, designSessionId))
  await db
    .delete(designPlanMilestones)
    .where(eq(designPlanMilestones.designSessionId, designSessionId))

  for (const [mIdx, milestone] of milestones.entries()) {
    await db.insert(designPlanMilestones).values({
      designSessionId,
      milestoneIndex: mIdx,
      sortOrder: mIdx,
      title: milestone.title ?? '',
      description: milestone.description ?? '',
      successCriteria: milestone.successCriteria ?? '',
      confirmed: milestone.confirmed === undefined ? null : milestone.confirmed ? 1 : 0
    })

    for (const [sIdx, slice] of milestone.slices.entries()) {
      await db.insert(designPlanSlices).values({
        designSessionId,
        milestoneIndex: mIdx,
        sliceIndex: sIdx,
        sortOrder: mIdx * 1000 + sIdx,
        title: slice.title ?? '',
        description: slice.description ?? '',
        successCriteria: slice.successCriteria,
        dependsOnSliceRefsJson: slice.dependsOnSliceRefs?.length
          ? JSON.stringify(slice.dependsOnSliceRefs)
          : null,
        confirmed: slice.confirmed === undefined ? null : slice.confirmed ? 1 : 0
      })
    }
  }
}

async function savePlanTasks(
  db: AppDatabase,
  designSessionId: string,
  tasks: FlatTaskPlan[]
): Promise<void> {
  await db.delete(designPlanTasks).where(eq(designPlanTasks.designSessionId, designSessionId))

  for (const [index, task] of tasks.entries()) {
    await db.insert(designPlanTasks).values({
      designSessionId,
      taskId: task.id,
      sortOrder: index,
      milestoneIndex: task.milestoneIndex,
      sliceIndex: task.sliceIndex,
      taskIndex: task.taskIndex,
      title: task.title,
      description: task.description,
      taskKind: task.taskKind,
      abilityCode: task.abilityCode,
      contextMarkdown: task.contextMarkdown,
      coreCode: task.coreCode ?? null,
      successCriteria: task.successCriteria,
      referenceIdsJson: task.referenceIds?.length ? JSON.stringify(task.referenceIds) : null,
      referenceReason: task.referenceReason ?? null,
      dependsOnTaskRefsJson: task.dependsOnTaskRefs?.length
        ? JSON.stringify(task.dependsOnTaskRefs)
        : null,
      canRunInParallel: task.canRunInParallel ? 1 : 0,
      confirmed: task.confirmed === undefined ? null : task.confirmed ? 1 : 0
    })
  }
}

export async function loadDesignAbilities(
  db: AppDatabase,
  designSessionId: string
): Promise<ThreadJobAbilityDto[]> {
  const rows = await db
    .select()
    .from(designAbilities)
    .where(eq(designAbilities.designSessionId, designSessionId))
    .orderBy(asc(designAbilities.sortOrder))

  return rows.map(mapAbilityRow)
}

export async function saveDesignAbilities(
  db: AppDatabase,
  designSessionId: string,
  abilities: ThreadJobAbilityDto[]
): Promise<void> {
  await db.delete(designAbilities).where(eq(designAbilities.designSessionId, designSessionId))

  for (const [index, ability] of abilities.entries()) {
    await db.insert(designAbilities).values({
      designSessionId,
      abilityCode: ability.abilityCode,
      sortOrder: index,
      label: ability.label ?? null,
      recommendedCoreCode: ability.recommendedCoreCode ?? null
    })
  }
}

export async function loadDesignPlan(
  db: AppDatabase,
  designSessionId: string
): Promise<SavedJobPlan | null> {
  const sessionRow = (
    await db.select().from(designSessions).where(eq(designSessions.id, designSessionId)).limit(1)
  )[0]
  if (!sessionRow) return null

  const taskRows = await db
    .select()
    .from(designPlanTasks)
    .where(eq(designPlanTasks.designSessionId, designSessionId))
    .orderBy(asc(designPlanTasks.sortOrder))

  const flatTasks = taskRows.map(mapPlanTaskRow)
  const milestonesFromDb = await loadPlanMilestonesFromDb(db, designSessionId, flatTasks)

  if (milestonesFromDb === null && flatTasks.length === 0) return null

  return {
    milestones: milestonesFromDb ?? [],
    tasks: flatTasks
  }
}

export function saveDesignPlanInTx(
  db: AppDatabase,
  designSessionId: string,
  plan: SavedJobPlan | null
): void {
  if (!plan) {
    db.delete(designPlanSlices).where(eq(designPlanSlices.designSessionId, designSessionId)).run()
    db
      .delete(designPlanMilestones)
      .where(eq(designPlanMilestones.designSessionId, designSessionId))
      .run()
    db.delete(designPlanTasks).where(eq(designPlanTasks.designSessionId, designSessionId)).run()
    return
  }

  db.delete(designPlanSlices).where(eq(designPlanSlices.designSessionId, designSessionId)).run()
  db
    .delete(designPlanMilestones)
    .where(eq(designPlanMilestones.designSessionId, designSessionId))
    .run()

  for (const [mIdx, milestone] of plan.milestones.entries()) {
    db.insert(designPlanMilestones)
      .values({
        designSessionId,
        milestoneIndex: mIdx,
        sortOrder: mIdx,
        title: milestone.title ?? '',
        description: milestone.description ?? '',
        successCriteria: milestone.successCriteria ?? '',
        confirmed: milestone.confirmed === undefined ? null : milestone.confirmed ? 1 : 0
      })
      .run()

    for (const [sIdx, slice] of milestone.slices.entries()) {
      db.insert(designPlanSlices)
        .values({
          designSessionId,
          milestoneIndex: mIdx,
          sliceIndex: sIdx,
          sortOrder: mIdx * 1000 + sIdx,
          title: slice.title ?? '',
          description: slice.description ?? '',
          successCriteria: slice.successCriteria,
          dependsOnSliceRefsJson: slice.dependsOnSliceRefs?.length
            ? JSON.stringify(slice.dependsOnSliceRefs)
            : null,
          confirmed: slice.confirmed === undefined ? null : slice.confirmed ? 1 : 0
        })
        .run()
    }
  }

  db.delete(designPlanTasks).where(eq(designPlanTasks.designSessionId, designSessionId)).run()
  for (const [index, task] of plan.tasks.entries()) {
    db.insert(designPlanTasks)
      .values({
        designSessionId,
        taskId: task.id,
        sortOrder: index,
        milestoneIndex: task.milestoneIndex,
        sliceIndex: task.sliceIndex,
        taskIndex: task.taskIndex,
        title: task.title,
        description: task.description,
        taskKind: task.taskKind,
        abilityCode: task.abilityCode,
        contextMarkdown: task.contextMarkdown,
        coreCode: task.coreCode ?? null,
        successCriteria: task.successCriteria,
        referenceIdsJson: task.referenceIds?.length ? JSON.stringify(task.referenceIds) : null,
        referenceReason: task.referenceReason ?? null,
        dependsOnTaskRefsJson: task.dependsOnTaskRefs?.length
          ? JSON.stringify(task.dependsOnTaskRefs)
          : null,
        canRunInParallel: task.canRunInParallel ? 1 : 0,
        confirmed: task.confirmed === undefined ? null : task.confirmed ? 1 : 0
      })
      .run()
  }
}

export async function saveDesignPlan(
  db: AppDatabase,
  designSessionId: string,
  plan: SavedJobPlan | null
): Promise<void> {
  saveDesignPlanInTx(db, designSessionId, plan)
}

export async function loadDesignPlanProgress(
  db: AppDatabase,
  designSessionId: string
): Promise<PlanProgressDto> {
  const row = (
    await db.select().from(designSessions).where(eq(designSessions.id, designSessionId)).limit(1)
  )[0]
  if (!row) return defaultPlanProgress()

  const counts = parseCounts(row.planCountsJson)
  return {
    phase: row.planPhase as PlanProgressDto['phase'],
    status: row.planStatus as PlanProgressDto['status'],
    contextsRegistered: row.planContextsRegistered,
    contextsTotal: row.planContextsTotal,
    milestones: counts.milestones,
    slices: counts.slices,
    tasks: counts.tasks,
    message: row.planMessage
  }
}

export async function saveDesignPlanProgress(
  db: AppDatabase,
  designSessionId: string,
  progress: PlanProgressDto
): Promise<void> {
  const counts: PlanCounts = {
    milestones: progress.milestones,
    slices: progress.slices,
    tasks: progress.tasks
  }

  await db
    .update(designSessions)
    .set({
      planPhase: progress.phase,
      planStatus: progress.status,
      planContextsRegistered: progress.contextsRegistered,
      planContextsTotal: progress.contextsTotal,
      planMessage: progress.message ?? null,
      planCountsJson: JSON.stringify(counts)
    })
    .where(eq(designSessions.id, designSessionId))
}

export async function copyDesignPlanToJob(
  db: AppDatabase,
  designSessionId: string,
  jobId: string
): Promise<void> {
  const { saveJobAbilities, saveJobPlan } = await import('./job-plan')
  const plan = await loadDesignPlan(db, designSessionId)
  const abilities = await loadDesignAbilities(db, designSessionId)
  await saveJobAbilities(db, jobId, abilities)
  await saveJobPlan(db, jobId, plan)
}
