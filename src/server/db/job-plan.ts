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
import { jobAbilities, jobPlanMilestones, jobPlanSlices, jobPlanTasks, threadJobs } from './schema'

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

function mapAbilityRow(row: typeof jobAbilities.$inferSelect): ThreadJobAbilityDto {
  return {
    abilityCode: row.abilityCode,
    label: row.label ?? undefined,
    recommendedCoreCode: row.recommendedCoreCode ?? undefined
  }
}

function mapPlanTaskRow(row: typeof jobPlanTasks.$inferSelect): FlatTaskPlan {
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
  milestoneRows: Array<typeof jobPlanMilestones.$inferSelect>,
  sliceRows: Array<typeof jobPlanSlices.$inferSelect>,
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
  jobId: string,
  flatTasks: FlatTaskPlan[]
): Promise<PlannerRegisteredMilestone[] | null> {
  const milestoneRows = await db
    .select()
    .from(jobPlanMilestones)
    .where(eq(jobPlanMilestones.jobId, jobId))
    .orderBy(asc(jobPlanMilestones.sortOrder))

  if (milestoneRows.length === 0) return null

  const sliceRows = await db
    .select()
    .from(jobPlanSlices)
    .where(eq(jobPlanSlices.jobId, jobId))
    .orderBy(asc(jobPlanSlices.sortOrder))

  return assembleMilestones(milestoneRows, sliceRows, flatTasks)
}

async function savePlanMilestones(
  db: AppDatabase,
  jobId: string,
  milestones: PlannerRegisteredMilestone[]
): Promise<void> {
  await db.delete(jobPlanSlices).where(eq(jobPlanSlices.jobId, jobId))
  await db.delete(jobPlanMilestones).where(eq(jobPlanMilestones.jobId, jobId))

  for (const [mIdx, milestone] of milestones.entries()) {
    await db.insert(jobPlanMilestones).values({
      jobId,
      milestoneIndex: mIdx,
      sortOrder: mIdx,
      title: milestone.title ?? '',
      description: milestone.description ?? '',
      successCriteria: milestone.successCriteria ?? '',
      confirmed: milestone.confirmed === undefined ? null : milestone.confirmed ? 1 : 0
    })

    for (const [sIdx, slice] of milestone.slices.entries()) {
      await db.insert(jobPlanSlices).values({
        jobId,
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

async function savePlanTasks(db: AppDatabase, jobId: string, tasks: FlatTaskPlan[]): Promise<void> {
  await db.delete(jobPlanTasks).where(eq(jobPlanTasks.jobId, jobId))

  for (const [index, task] of tasks.entries()) {
    await db.insert(jobPlanTasks).values({
      jobId,
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

export async function loadJobAbilities(
  db: AppDatabase,
  jobId: string
): Promise<ThreadJobAbilityDto[]> {
  const rows = await db
    .select()
    .from(jobAbilities)
    .where(eq(jobAbilities.jobId, jobId))
    .orderBy(asc(jobAbilities.sortOrder))

  return rows.map(mapAbilityRow)
}

export async function saveJobAbilities(
  db: AppDatabase,
  jobId: string,
  abilities: ThreadJobAbilityDto[]
): Promise<void> {
  await db.delete(jobAbilities).where(eq(jobAbilities.jobId, jobId))

  for (const [index, ability] of abilities.entries()) {
    await db.insert(jobAbilities).values({
      jobId,
      abilityCode: ability.abilityCode,
      sortOrder: index,
      label: ability.label ?? null,
      recommendedCoreCode: ability.recommendedCoreCode ?? null
    })
  }
}

export async function loadJobPlan(db: AppDatabase, jobId: string): Promise<SavedJobPlan | null> {
  const jobRow = (await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1))[0]
  if (!jobRow) return null

  const taskRows = await db
    .select()
    .from(jobPlanTasks)
    .where(eq(jobPlanTasks.jobId, jobId))
    .orderBy(asc(jobPlanTasks.sortOrder))

  const flatTasks = taskRows.map(mapPlanTaskRow)
  const milestonesFromDb = await loadPlanMilestonesFromDb(db, jobId, flatTasks)

  if (milestonesFromDb === null && flatTasks.length === 0) return null

  return {
    milestones: milestonesFromDb ?? [],
    tasks: flatTasks
  }
}

function savePlanMilestonesInTx(
  db: AppDatabase,
  jobId: string,
  milestones: PlannerRegisteredMilestone[]
): void {
  db.delete(jobPlanSlices).where(eq(jobPlanSlices.jobId, jobId)).run()
  db.delete(jobPlanMilestones).where(eq(jobPlanMilestones.jobId, jobId)).run()

  for (const [mIdx, milestone] of milestones.entries()) {
    db.insert(jobPlanMilestones)
      .values({
        jobId,
        milestoneIndex: mIdx,
        sortOrder: mIdx,
        title: milestone.title ?? '',
        description: milestone.description ?? '',
        successCriteria: milestone.successCriteria ?? '',
        confirmed: milestone.confirmed === undefined ? null : milestone.confirmed ? 1 : 0
      })
      .run()

    for (const [sIdx, slice] of milestone.slices.entries()) {
      db.insert(jobPlanSlices)
        .values({
          jobId,
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
}

function savePlanTasksInTx(db: AppDatabase, jobId: string, tasks: FlatTaskPlan[]): void {
  db.delete(jobPlanTasks).where(eq(jobPlanTasks.jobId, jobId)).run()

  for (const [index, task] of tasks.entries()) {
    db.insert(jobPlanTasks)
      .values({
        jobId,
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

export function saveJobPlanInTx(
  db: AppDatabase,
  jobId: string,
  plan: SavedJobPlan | null
): void {
  if (!plan) {
    db.delete(jobPlanSlices).where(eq(jobPlanSlices.jobId, jobId)).run()
    db.delete(jobPlanMilestones).where(eq(jobPlanMilestones.jobId, jobId)).run()
    db.delete(jobPlanTasks).where(eq(jobPlanTasks.jobId, jobId)).run()
    return
  }

  savePlanMilestonesInTx(db, jobId, plan.milestones)
  savePlanTasksInTx(db, jobId, plan.tasks)
}

export async function saveJobPlan(
  db: AppDatabase,
  jobId: string,
  plan: SavedJobPlan | null
): Promise<void> {
  saveJobPlanInTx(db, jobId, plan)
}

export async function loadPlanProgress(db: AppDatabase, jobId: string): Promise<PlanProgressDto> {
  const row = (await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1))[0]
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

export async function savePlanProgress(
  db: AppDatabase,
  jobId: string,
  progress: PlanProgressDto
): Promise<void> {
  const counts: PlanCounts = {
    milestones: progress.milestones,
    slices: progress.slices,
    tasks: progress.tasks
  }

  await db
    .update(threadJobs)
    .set({
      planPhase: progress.phase,
      planStatus: progress.status,
      planContextsRegistered: progress.contextsRegistered,
      planContextsTotal: progress.contextsTotal,
      planMessage: progress.message ?? null,
      planCountsJson: JSON.stringify(counts)
    })
    .where(eq(threadJobs.id, jobId))
}
