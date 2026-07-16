import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { loadJobPlan } from '../db/job-plan'
import { threadJobs } from '../db/schema'
import type { SliceVerificationRecordDto } from '@shared/contracts/evidence'
import type {
  TaskProgressDto,
  TaskProgressItemDto,
  TaskProgressSliceDto,
  ThreadJobDto
} from './types'
import type { SavedJobPlan } from '../planner/plan-types'
import { ensureCoreAvailable, type SupportedCoreCode } from '../conversation/cores'
import { ensureJobRuntimeRoot, ensureJobTaskRuntimeRoot, streamAgentTurn } from '../agent-runtime/runner'
import { ensureCursorAcpRuntimeDirs } from '../agent-runtime/env'
import { memoryDebug } from '../debug/memory'
import { cleanupJobTaskRuntimeTree } from '../runtime/cleanup'
import { parseSuspensionKind } from '../../shared/job-suspension.ts'
import { slimTaskProgressItemsForRuntime } from './evidence/store'
import { finalizeJobExecution } from './finalize-execution'
import { getExecutionRunContext, runWithExecutionRunContext } from './execution-run-context'
import { updateJobRowFenced, updateJobRowForSnapshotFenced } from './repository'
import {
  emitJobError,
  emitJobProgressAfterPersist,
  type JobProgressEmitMode
} from './progress-emit'
import { getTaskEvidenceWaitTimeoutForTests } from '../agent-runtime/providers/test-overrides'
import { resolveCoreModel } from '../conversation/models'
import {
  applyTaskProgressToGate,
  applyVerificationProgress,
  buildGateStates,
  exportVerificationProgress,
  findFlatTask,
  findMilestoneReadyForVerification,
  findNextReadyTask,
  findSliceReadyForVerification,
  isWorkflowComplete,
  reconcileMilestoneStatuses,
  reconcileSliceStatuses,
  TASK_EVIDENCE_BASIC_FACTS_OK,
  type GateMilestoneState,
  type GateSliceState
} from './execution-gate'
import {
  resetInterruptedGateVerification,
  resetInterruptedRunningTasks,
  syncTaskProgressForJobFailure,
  readPausingAttempt,
  withPausingAttempt
} from './execution-recovery'
import {
  createExecutionAbortSignal,
  markJobExecuting,
  markJobExecutionDone,
  pauseJobExecution,
  shouldStopExecution
} from './controls'
import {
  beginTaskAttempt,
  commitCompletedTaskAttempt,
  markTaskAttemptProviderStarted,
  markTaskAttemptFailed
} from './task-attempts'
import { isDraining } from './shutdown-state'
import {
  registerTaskMcpSession,
  unregisterTaskMcpSession,
  type TaskEvidencePacket
} from './mcp/task-session'
import { buildTaskWorkerMcpUrl } from './mcp/task-url'
import { buildTaskWorkerUserMessage, TASK_EXECUTION_SYSTEM_PROMPT } from './prompts'
import { emitJobEvent, getUserJob, updateJobRow, updateJobRowForSnapshot } from './service'
import {
  isExecutionInfraNotReadyError,
  revertJobAfterInfraStartupFailure
} from './execution-startup'
import { refreshExecutionLease } from './repository'
import {
  resolveTaskReferenceReadRoots,
  buildAssignedReferenceCorpusMarkdown
} from '../sandbox/reference-roots'
import {
  loadJobReferenceManifestForJob,
  ReferenceFileMissingError,
  resolveAssignedReferenceLocalPaths
} from './reference-manifest'
import {
  runMilestoneVerification,
  runSliceVerification,
  toSliceVerificationRecord
} from './verifier'
import { preflightMilestoneSliceVerdicts, preflightSliceTaskEvidence } from './evidence/preflight'
import { getAppContext, type AppContext } from '../bootstrap'
import {
  DEFAULT_MAX_REPAIR_TASKS_PER_VERDICT,
  injectMilestoneEvidenceRepairTask,
  injectMilestoneRepairTasks,
  injectSliceEvidenceRepairTask,
  injectSliceRepairTasks,
  MAX_REPAIR_GENERATIONS,
  repairGenerationKey
} from './repair-tasks'
import { computeMilestoneEvidenceBundleHash, computeSliceEvidenceBundleHash } from './evidence/hash'
import {
  guardVerificationAttempt,
  MAX_VERIFICATION_ATTEMPTS,
  verificationAttemptCount,
  withVerificationAttempt
} from './verification-attempts'
import type { MilestoneVerificationVerdict, SliceVerificationVerdict } from './verification/types'
import { taskFailureFromSandboxError } from '../sandbox/sandbox-failure'
import {
  applyTaskInfraRetryItem,
  applyTaskPrepRecoveryItem,
  applyTaskRepairRecoveryItem,
  applyTaskRecoveryGenerationForTask,
  applyTaskTerminalFailureItem,
  applyEvidenceMissInfraRetryItem,
  injectPrepTasksForRecovery,
  injectRepairTasksForRecovery,
  resolveTaskInfraRecovery,
  resolveTaskRecoveryAction,
  sleepMs
} from './task-blocker'
import { MAX_PAUSING_TURN_ATTEMPTS, TASK_EVIDENCE_GRACE_MS } from './recovery-limits'
import { resolveVerifierInfraRecovery, withVerifierInfraAttempt } from './verification-recovery'
import {
  createTurnError,
  isInfraTurnError,
  isRetryableTurnError,
  isTurnError,
  JOB_CANCELLED,
  JOB_PAUSED,
  normalizeTurnError
} from '../../shared/turn-errors.ts'
import type { TurnErrorDto } from '../../shared/turn-errors.ts'
import type { JobProgressCode, JobProgressParams } from '../../shared/progress-codes.ts'
import { taskErrorFields, taskErrorFieldsFromDto, turnErrorMessage } from '../turn-errors/store'

type ExecuteSingleTaskResult =
  | { kind: 'completed'; items: TaskProgressItemDto[] }
  | {
      kind: 'failed'
      items: TaskProgressItemDto[]
      lastError: TurnErrorDto
      progressCode?: JobProgressCode
      progressParams?: JobProgressParams
    }
  | {
      kind: 'recovered'
      items: TaskProgressItemDto[]
      progressCode: JobProgressCode
      progressParams?: JobProgressParams
      plan: SavedJobPlan
      taskProgress: TaskProgressDto
      gate: ReturnType<typeof buildGateStates>
      delayMs?: number
    }
  | {
      kind: 'paused'
      items: TaskProgressItemDto[]
      lastError: TurnErrorDto
      taskProgress: TaskProgressDto
    }
  // FIX-PLAN F3-C (§8.4): app shutdown interrupted the turn at a safe checkpoint. NOT a failure and
  // NOT a user pause — the Job stays auto-recoverable `running`.
  | {
      kind: 'interrupted'
      items: TaskProgressItemDto[]
    }

export function initJobExecutor(_ctx: AppContext): void {
  getAppContext()
}

function mergeAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

async function loadJobRow(jobId: string): Promise<typeof threadJobs.$inferSelect | null> {
  const db = getDb()
  const rows = await db.select().from(threadJobs).where(eq(threadJobs.id, jobId)).limit(1)
  return rows[0] ?? null
}

function resolveCoreForAbility(job: ThreadJobDto, abilityCode: string): SupportedCoreCode {
  const match = job.abilities.find((item) => item.abilityCode === abilityCode)
  const code = match?.recommendedCoreCode?.trim()
  if (code) return code as SupportedCoreCode

  const configured = job.abilities.map((item) => item.recommendedCoreCode?.trim()).find(Boolean)
  if (configured) return configured as SupportedCoreCode

  return 'codex'
}

function resolveCoreForTask(
  job: ThreadJobDto,
  flat: { abilityCode: string; coreCode?: string | undefined }
): SupportedCoreCode {
  const override = flat.coreCode?.trim()
  if (override) return override as SupportedCoreCode
  return resolveCoreForAbility(job, flat.abilityCode)
}

function taskItemsFromProgress(taskProgress: TaskProgressDto): TaskProgressItemDto[] {
  return taskProgress.tasks.map((item) => ({ ...item }))
}

function executionAbortSignal(jobId: string): AbortSignal {
  const ctx = getExecutionRunContext()
  const jobSignal = createExecutionAbortSignal(jobId)
  if (ctx?.signal) {
    return mergeAbortSignals(ctx.signal, jobSignal)
  }
  return jobSignal
}

async function updateExecutionJobRow(
  jobId: string,
  patch: Parameters<typeof updateJobRow>[1]
): Promise<ThreadJobDto | null> {
  const ctx = getExecutionRunContext()
  if (ctx?.runId) {
    const { assertRunWritable } = await import('./workload-slot-store')
    if (!(await assertRunWritable('thread_job', jobId, ctx.runId))) return null
    return updateJobRowFenced(jobId, ctx.runId, patch)
  }
  const { getActiveRun } = await import('./workload-slot-store')
  if (await getActiveRun('thread_job', jobId)) return null
  return updateJobRow(jobId, patch)
}

async function persistTaskProgress(
  jobId: string,
  taskProgress: TaskProgressDto,
  patch?: Partial<{
    status: string
    lastError: TurnErrorDto | string | null
    suspensionKind: import('../../shared/job-suspension.ts').SuspensionKind
    continueAfterPause: boolean | number
    recoveryReason: import('../../shared/job-suspension.ts').JobRecoveryReason
  }>,
  gate?: ReturnType<typeof buildGateStates>,
  emit: JobProgressEmitMode = 'delta'
): Promise<ThreadJobDto | null> {
  const ctx = getExecutionRunContext()
  const expectedRunId = ctx?.runId
  if (expectedRunId) {
    const { assertRunWritable } = await import('./workload-slot-store')
    if (!(await assertRunWritable('thread_job', jobId, expectedRunId))) {
      memoryDebug('persistTaskProgress: stale execution run ignored', { jobId, expectedRunId })
      return null
    }
  } else {
    const { getActiveRun } = await import('./workload-slot-store')
    if (await getActiveRun('thread_job', jobId)) {
      memoryDebug('persistTaskProgress: missing run context with active run', { jobId })
      return null
    }
  }

  const progress: TaskProgressDto = gate
    ? {
        ...taskProgress,
        ...exportVerificationProgress(gate.slices, gate.milestones, {
          slices: taskProgress.slices
        })
      }
    : taskProgress
  const includePlan = emit === 'snapshot' || emit === 'terminal'
  const job = expectedRunId
    ? await updateJobRowFenced(
        jobId,
        expectedRunId,
        {
          taskProgress: progress,
          ...patch
        },
        { includePlan, hydrateEvidence: false }
      )
    : await updateJobRow(
        jobId,
        {
          taskProgress: progress,
          ...patch
        },
        { includePlan, hydrateEvidence: false }
      )
  emitJobProgressAfterPersist(jobId, emit, { taskProgress: progress, job })
  memoryDebug('persistTaskProgress', {
    jobId,
    emit,
    taskCount: progress.tasks.length,
    status: patch?.status ?? null
  })
  return job
}

async function cleanupDurableTaskRuntime(
  dataDir: string,
  threadId: string,
  jobId: string,
  taskId: string
): Promise<void> {
  await cleanupJobTaskRuntimeTree(dataDir, threadId, jobId, taskId).catch((error) => {
    console.warn('[retention] completed task runtime cleanup failed', jobId, taskId, error)
  })
}

function updateTaskItem(
  items: TaskProgressItemDto[],
  taskId: string,
  patch: Partial<TaskProgressItemDto>
): TaskProgressItemDto[] {
  return items.map((item) => (item.id === taskId ? { ...item, ...patch } : item))
}

function upsertSliceVerdict(
  slices: TaskProgressSliceDto[] | undefined,
  sliceId: string,
  verdict: SliceVerificationRecordDto
): TaskProgressSliceDto[] {
  const list = [...(slices ?? [])]
  const index = list.findIndex((row) => row.id === sliceId)
  const existing = index >= 0 ? list[index] : undefined
  if (existing) {
    list[index] = { ...existing, verdict }
  } else {
    list.push({ id: sliceId, verdict })
  }
  return list
}

function applyTaskEvidenceResult(
  items: TaskProgressItemDto[],
  taskId: string,
  packet: TaskEvidencePacket
): TaskProgressItemDto[] {
  if (packet.status === 'completed') {
    return updateTaskItem(items, taskId, {
      status: 'completed',
      executionStatus: 'completed',
      evidenceStatus: TASK_EVIDENCE_BASIC_FACTS_OK,
      evidence: packet,
      errorMessage: null
    })
  }
  const message = `Task reported ${packet.status}${packet.blockers?.length ? `: ${packet.blockers.join('; ')}` : ''}`
  return updateTaskItem(items, taskId, {
    status: 'failed',
    executionStatus: packet.status,
    evidenceStatus: TASK_EVIDENCE_BASIC_FACTS_OK,
    evidence: packet,
    errorMessage: message
  })
}

function processTaskEvidenceOutcome(input: {
  items: TaskProgressItemDto[]
  taskId: string
  packet: TaskEvidencePacket
  plan: SavedJobPlan
  taskProgress: TaskProgressDto
  gate: ReturnType<typeof buildGateStates>
}): ExecuteSingleTaskResult {
  if (input.packet.status === 'completed') {
    return {
      kind: 'completed',
      items: applyTaskEvidenceResult(input.items, input.taskId, input.packet)
    }
  }

  const recovery = resolveTaskRecoveryAction({
    packet: input.packet,
    taskId: input.taskId,
    taskProgress: input.taskProgress
  })
  const classification = recovery.classification

  if (recovery.action === 'infra-retry') {
    const items = applyTaskInfraRetryItem(
      input.items,
      input.taskId,
      input.packet,
      classification,
      recovery.attempt,
      recovery.maxAttempts
    )
    const taskProgress = applyTaskRecoveryGenerationForTask(
      { ...input.taskProgress, tasks: items },
      input.taskId,
      recovery
    )
    const gate = rebuildGatePreservingVerification(input.plan, input.gate, taskProgress, items)
    reconcileSliceStatuses(gate.slices)
    reconcileMilestoneStatuses(gate.milestones, gate.slices)
    return {
      kind: 'recovered',
      items,
      progressCode: 'execution.recovery_infra_retry',
      progressParams: {
        id: input.taskId,
        attempt: recovery.attempt,
        maxAttempts: recovery.maxAttempts
      },
      plan: input.plan,
      taskProgress: { ...taskProgress, tasks: items },
      gate,
      delayMs: recovery.delayMs
    }
  }

  if (recovery.action === 'inject-prep') {
    const newTaskIds = injectPrepTasksForRecovery({
      plan: input.plan,
      blockedTaskId: input.taskId,
      packet: input.packet,
      attempt: recovery.attempt
    })
    let items = appendQueuedRepairItems(input.plan, input.items, newTaskIds)
    items = applyTaskPrepRecoveryItem(
      items,
      input.taskId,
      input.packet,
      classification,
      recovery.attempt,
      recovery.maxAttempts
    )
    const taskProgress = applyTaskRecoveryGenerationForTask(
      { ...input.taskProgress, tasks: items },
      input.taskId,
      recovery
    )
    const gate = rebuildGatePreservingVerification(input.plan, input.gate, taskProgress, items)
    reconcileSliceStatuses(gate.slices)
    reconcileMilestoneStatuses(gate.milestones, gate.slices)
    return {
      kind: 'recovered',
      items,
      progressCode: 'execution.recovery_prep_injected',
      progressParams: { id: input.taskId, count: newTaskIds.length },
      plan: input.plan,
      taskProgress: { ...taskProgress, tasks: items, total: items.length },
      gate
    }
  }

  if (recovery.action === 'inject-repair') {
    const newTaskIds = injectRepairTasksForRecovery({
      plan: input.plan,
      blockedTaskId: input.taskId,
      packet: input.packet,
      attempt: recovery.attempt
    })
    let items = appendQueuedRepairItems(input.plan, input.items, newTaskIds)
    items = applyTaskRepairRecoveryItem(
      items,
      input.taskId,
      input.packet,
      classification,
      recovery.attempt,
      recovery.maxAttempts
    )
    const taskProgress = applyTaskRecoveryGenerationForTask(
      { ...input.taskProgress, tasks: items },
      input.taskId,
      recovery
    )
    const gate = rebuildGatePreservingVerification(input.plan, input.gate, taskProgress, items)
    reconcileSliceStatuses(gate.slices)
    reconcileMilestoneStatuses(gate.milestones, gate.slices)
    return {
      kind: 'recovered',
      items,
      progressCode: 'execution.recovery_repair_injected',
      progressParams: { id: input.taskId, count: newTaskIds.length },
      plan: input.plan,
      taskProgress: { ...taskProgress, tasks: items, total: items.length },
      gate
    }
  }

  if (recovery.action === 'pause-human') {
    const items = applyTaskTerminalFailureItem(
      input.items,
      input.taskId,
      input.packet,
      classification,
      recovery.error
    )
    return {
      kind: 'paused',
      items,
      lastError: recovery.error,
      taskProgress: { ...input.taskProgress, tasks: items }
    }
  }

  return {
    kind: 'failed',
    items: applyTaskTerminalFailureItem(
      input.items,
      input.taskId,
      input.packet,
      classification,
      recovery.error
    ),
    lastError: recovery.error,
    progressCode: 'execution.failed',
    progressParams: { id: input.taskId }
  }
}

function countCompleted(items: TaskProgressItemDto[]): number {
  return items.filter((item) => item.status === 'completed' || item.status === 'skipped').length
}

function repairGeneration(
  progress: TaskProgressDto,
  scope: 'slice' | 'milestone',
  id: string
): number {
  return progress.repairGenerations?.[repairGenerationKey(scope, id)] ?? 0
}

function withRepairGeneration(
  progress: TaskProgressDto,
  scope: 'slice' | 'milestone',
  id: string,
  generation: number
): TaskProgressDto {
  const key = repairGenerationKey(scope, id)
  return {
    ...progress,
    repairGenerations: {
      ...(progress.repairGenerations ?? {}),
      [key]: generation
    }
  }
}

function resetSliceVerificationState(
  sliceId: string,
  gate: ReturnType<typeof buildGateStates>
): void {
  const slice = gate.slices.find((s) => s.id === sliceId)
  if (!slice) return
  slice.runtimeStatus = null
  slice.verificationStatus = null
  slice.status = 'pending'
}

function appendQueuedRepairItems(
  plan: SavedJobPlan,
  items: TaskProgressItemDto[],
  newTaskIds: string[]
): TaskProgressItemDto[] {
  const next = [...items]
  for (const taskId of newTaskIds) {
    if (next.some((item) => item.id === taskId)) continue
    const flat = findFlatTask(plan, taskId)
    if (!flat) continue
    next.push({
      id: flat.id,
      title: flat.title,
      status: 'queued',
      abilityCode: flat.abilityCode,
      executionStatus: 'queued',
      evidenceStatus: null,
      errorMessage: null,
      coreCode: null
    })
  }
  return next
}

async function persistPlanAndProgress(
  jobId: string,
  plan: SavedJobPlan,
  taskProgress: TaskProgressDto,
  patch?: Partial<{ status: string; lastError: TurnErrorDto | string | null }>,
  gate?: ReturnType<typeof buildGateStates>,
  emit: JobProgressEmitMode = 'snapshot'
): Promise<ThreadJobDto | null> {
  const ctx = getExecutionRunContext()
  const expectedRunId = ctx?.runId
  if (expectedRunId) {
    const { assertRunWritable } = await import('./workload-slot-store')
    if (!(await assertRunWritable('thread_job', jobId, expectedRunId))) {
      memoryDebug('persistPlanAndProgress: stale execution run ignored', { jobId, expectedRunId })
      return null
    }
  } else {
    const { getActiveRun } = await import('./workload-slot-store')
    if (await getActiveRun('thread_job', jobId)) {
      memoryDebug('persistPlanAndProgress: missing run context with active run', { jobId })
      return null
    }
  }

  const progress: TaskProgressDto = gate
    ? {
        ...taskProgress,
        total: taskProgress.tasks.length,
        ...exportVerificationProgress(gate.slices, gate.milestones, {
          slices: taskProgress.slices
        })
      }
    : { ...taskProgress, total: taskProgress.tasks.length }

  const job = expectedRunId
    ? await updateJobRowFenced(
        jobId,
        expectedRunId,
        {
          plan,
          taskProgress: progress,
          ...patch
        },
        { includePlan: true, hydrateEvidence: false }
      )
    : await updateJobRow(
        jobId,
        {
          plan,
          taskProgress: progress,
          ...patch
        },
        { includePlan: true, hydrateEvidence: false }
      )
  emitJobProgressAfterPersist(jobId, emit, { taskProgress: progress, job })
  memoryDebug('persistPlanAndProgress', { jobId, emit, taskCount: progress.tasks.length })
  return job
}

function rebuildGatePreservingVerification(
  plan: SavedJobPlan,
  priorGate: ReturnType<typeof buildGateStates>,
  taskProgress: TaskProgressDto,
  items: TaskProgressItemDto[]
): ReturnType<typeof buildGateStates> {
  const preserved = exportVerificationProgress(priorGate.slices, priorGate.milestones, {
    slices: taskProgress.slices
  })
  const gate = buildGateStates(plan)
  applyVerificationProgress(gate.slices, gate.milestones, preserved)
  applyTaskProgressToGate(gate.tasks, items)
  return gate
}

function mergeVerificationProgress(
  taskProgress: TaskProgressDto,
  gate: ReturnType<typeof buildGateStates>
): TaskProgressDto {
  return {
    ...taskProgress,
    ...exportVerificationProgress(gate.slices, gate.milestones, { slices: taskProgress.slices })
  }
}

async function handleSliceNeedsRepair(input: {
  jobId: string
  plan: SavedJobPlan
  sliceId: string
  verdict: SliceVerificationVerdict
  items: TaskProgressItemDto[]
  taskProgress: TaskProgressDto
  gate: ReturnType<typeof buildGateStates>
}): Promise<
  | {
      ok: true
      plan: SavedJobPlan
      items: TaskProgressItemDto[]
      taskProgress: TaskProgressDto
      gate: ReturnType<typeof buildGateStates>
    }
  | { ok: false; progressCode: JobProgressCode; progressParams: JobProgressParams }
> {
  const generation = repairGeneration(input.taskProgress, 'slice', input.sliceId) + 1
  if (generation > MAX_REPAIR_GENERATIONS) {
    return {
      ok: false,
      progressCode: 'execution.slice_inconclusive_exhausted',
      progressParams: { id: input.sliceId, maxAttempts: MAX_REPAIR_GENERATIONS }
    }
  }

  const injection = injectSliceRepairTasks({
    plan: input.plan,
    sliceId: input.sliceId,
    verdict: input.verdict,
    generation,
    maxTasksPerVerdict: DEFAULT_MAX_REPAIR_TASKS_PER_VERDICT
  })
  if (injection.created === 0) {
    return {
      ok: false,
      progressCode: 'execution.slice_blocked',
      progressParams: { id: input.sliceId }
    }
  }

  const items = appendQueuedRepairItems(input.plan, input.items, injection.newTaskIds)
  const gate = rebuildGatePreservingVerification(input.plan, input.gate, input.taskProgress, items)
  resetSliceVerificationState(input.sliceId, gate)
  reconcileSliceStatuses(gate.slices)
  reconcileMilestoneStatuses(gate.milestones, gate.slices)

  const taskProgress = withRepairGeneration(
    mergeVerificationProgress(
      {
        ...input.taskProgress,
        phase: 'running',
        status: 'running',
        currentIndex: countCompleted(items),
        total: items.length,
        currentTaskId: null,
        message: null,
        progressCode: 'execution.recovery_repair_injected',
        progressParams: { id: input.sliceId, count: injection.created },
        tasks: items
      },
      gate
    ),
    'slice',
    input.sliceId,
    generation
  )

  await persistPlanAndProgress(input.jobId, input.plan, taskProgress, undefined, gate)
  return { ok: true, plan: input.plan, items, taskProgress, gate }
}

async function handleMilestoneNeedsRepair(input: {
  jobId: string
  plan: SavedJobPlan
  milestoneId: string
  verdict: MilestoneVerificationVerdict
  items: TaskProgressItemDto[]
  taskProgress: TaskProgressDto
  gate: ReturnType<typeof buildGateStates>
}): Promise<
  | {
      ok: true
      plan: SavedJobPlan
      items: TaskProgressItemDto[]
      taskProgress: TaskProgressDto
      gate: ReturnType<typeof buildGateStates>
    }
  | { ok: false; progressCode: JobProgressCode; progressParams: JobProgressParams }
> {
  const generation = repairGeneration(input.taskProgress, 'milestone', input.milestoneId) + 1
  if (generation > MAX_REPAIR_GENERATIONS) {
    return {
      ok: false,
      progressCode: 'execution.milestone_inconclusive_exhausted',
      progressParams: { id: input.milestoneId, maxAttempts: MAX_REPAIR_GENERATIONS }
    }
  }

  const injection = injectMilestoneRepairTasks({
    plan: input.plan,
    milestoneId: input.milestoneId,
    verdict: input.verdict,
    generation,
    maxTasksPerVerdict: DEFAULT_MAX_REPAIR_TASKS_PER_VERDICT
  })
  if (injection.created === 0) {
    return {
      ok: false,
      progressCode: 'execution.milestone_blocked',
      progressParams: { id: input.milestoneId }
    }
  }

  const affectedSlices = new Set(
    injection.newTaskIds.map((taskId) => {
      const flat = findFlatTask(input.plan, taskId)
      return flat ? `m${flat.milestoneIndex}-s${flat.sliceIndex}` : null
    })
  )

  const items = appendQueuedRepairItems(input.plan, input.items, injection.newTaskIds)
  const gate = rebuildGatePreservingVerification(input.plan, input.gate, input.taskProgress, items)
  for (const sliceId of affectedSlices) {
    if (sliceId) resetSliceVerificationState(sliceId, gate)
  }
  const milestone = gate.milestones.find((m) => m.id === input.milestoneId)
  if (milestone) {
    milestone.verificationStatus = null
    milestone.status = 'pending'
  }
  reconcileSliceStatuses(gate.slices)
  reconcileMilestoneStatuses(gate.milestones, gate.slices)

  const taskProgress = withRepairGeneration(
    mergeVerificationProgress(
      {
        ...input.taskProgress,
        phase: 'running',
        status: 'running',
        currentIndex: countCompleted(items),
        total: items.length,
        currentTaskId: null,
        message: null,
        progressCode: 'execution.recovery_repair_injected',
        progressParams: { id: input.milestoneId, count: injection.created },
        tasks: items
      },
      gate
    ),
    'milestone',
    input.milestoneId,
    generation
  )

  await persistPlanAndProgress(input.jobId, input.plan, taskProgress, undefined, gate)
  return { ok: true, plan: input.plan, items, taskProgress, gate }
}

async function handleSliceEvidenceRepair(input: {
  jobId: string
  plan: SavedJobPlan
  sliceId: string
  reason: string
  attempt: number
  bundleHash: string
  items: TaskProgressItemDto[]
  taskProgress: TaskProgressDto
  gate: ReturnType<typeof buildGateStates>
}): Promise<
  | {
      ok: true
      plan: SavedJobPlan
      items: TaskProgressItemDto[]
      taskProgress: TaskProgressDto
      gate: ReturnType<typeof buildGateStates>
    }
  | { ok: false; progressCode: JobProgressCode; progressParams: JobProgressParams }
> {
  const injection = injectSliceEvidenceRepairTask({
    plan: input.plan,
    sliceId: input.sliceId,
    reason: input.reason,
    attempt: input.attempt,
    maxAttempts: MAX_VERIFICATION_ATTEMPTS
  })

  const items = appendQueuedRepairItems(input.plan, input.items, injection.newTaskIds)
  const gate = rebuildGatePreservingVerification(input.plan, input.gate, input.taskProgress, items)
  resetSliceVerificationState(input.sliceId, gate)
  reconcileSliceStatuses(gate.slices)
  reconcileMilestoneStatuses(gate.milestones, gate.slices)

  const taskProgress = withVerificationAttempt(
    mergeVerificationProgress(
      {
        ...input.taskProgress,
        phase: 'running',
        status: 'running',
        currentIndex: countCompleted(items),
        total: items.length,
        currentTaskId: null,
        message: null,
        progressCode: 'execution.recovery_prep_injected',
        progressParams: {
          id: input.sliceId,
          attempt: input.attempt,
          maxAttempts: MAX_VERIFICATION_ATTEMPTS
        },
        tasks: items
      },
      gate
    ),
    'slice',
    input.sliceId,
    input.attempt,
    input.bundleHash
  )

  await persistPlanAndProgress(input.jobId, input.plan, taskProgress, undefined, gate)
  return { ok: true, plan: input.plan, items, taskProgress, gate }
}

async function handleMilestoneEvidenceRepair(input: {
  jobId: string
  plan: SavedJobPlan
  milestoneId: string
  reason: string
  attempt: number
  bundleHash: string
  items: TaskProgressItemDto[]
  taskProgress: TaskProgressDto
  gate: ReturnType<typeof buildGateStates>
}): Promise<
  | {
      ok: true
      plan: SavedJobPlan
      items: TaskProgressItemDto[]
      taskProgress: TaskProgressDto
      gate: ReturnType<typeof buildGateStates>
    }
  | { ok: false; progressCode: JobProgressCode; progressParams: JobProgressParams }
> {
  const injection = injectMilestoneEvidenceRepairTask({
    plan: input.plan,
    milestoneId: input.milestoneId,
    reason: input.reason,
    attempt: input.attempt,
    maxAttempts: MAX_VERIFICATION_ATTEMPTS
  })

  const affectedSlices = new Set(
    injection.newTaskIds.map((taskId) => {
      const flat = findFlatTask(input.plan, taskId)
      return flat ? `m${flat.milestoneIndex}-s${flat.sliceIndex}` : null
    })
  )

  const items = appendQueuedRepairItems(input.plan, input.items, injection.newTaskIds)
  const gate = rebuildGatePreservingVerification(input.plan, input.gate, input.taskProgress, items)
  for (const sliceId of affectedSlices) {
    if (sliceId) resetSliceVerificationState(sliceId, gate)
  }
  const milestone = gate.milestones.find((m) => m.id === input.milestoneId)
  if (milestone) {
    milestone.verificationStatus = null
    milestone.status = 'pending'
  }
  reconcileSliceStatuses(gate.slices)
  reconcileMilestoneStatuses(gate.milestones, gate.slices)

  const taskProgress = withVerificationAttempt(
    mergeVerificationProgress(
      {
        ...input.taskProgress,
        phase: 'running',
        status: 'running',
        currentIndex: countCompleted(items),
        total: items.length,
        currentTaskId: null,
        message: null,
        progressCode: 'execution.recovery_prep_injected',
        progressParams: {
          id: input.milestoneId,
          attempt: input.attempt,
          maxAttempts: MAX_VERIFICATION_ATTEMPTS
        },
        tasks: items
      },
      gate
    ),
    'milestone',
    input.milestoneId,
    input.attempt,
    input.bundleHash
  )

  await persistPlanAndProgress(input.jobId, input.plan, taskProgress, undefined, gate)
  return { ok: true, plan: input.plan, items, taskProgress, gate }
}

function taskTerminalError(taskId: string, detail?: string | null): TurnErrorDto {
  return createTurnError('task.terminal_failure', {
    params: { taskId },
    ...(detail ? { detail } : {})
  }).toDto()
}

async function failJobWithProgress(
  jobId: string,
  taskProgress: TaskProgressDto,
  items: TaskProgressItemDto[],
  gate: ReturnType<typeof buildGateStates>,
  progressCode: JobProgressCode,
  progressParams?: JobProgressParams,
  lastError?: TurnErrorDto
): Promise<void> {
  const error = lastError ?? createTurnError('turn.unknown').toDto()
  const failed = await persistTaskProgress(
    jobId,
    {
      ...taskProgress,
      phase: 'failed',
      status: 'failed',
      currentIndex: countCompleted(items),
      total: items.length,
      currentTaskId: null,
      message: null,
      progressCode,
      progressParams: progressParams ?? null,
      tasks: items
    },
    { status: 'failed', lastError: error },
    gate,
    'terminal'
  )
  if (failed) {
    items = slimTaskProgressItemsForRuntime(items)
  }
}

function startTaskEvidenceWait(
  sessionId: string,
  jobId: string,
  taskId: string,
  idempotencyKey: string,
  signal: AbortSignal,
  options?: {
    /** Optional initial arm. Production omits this — timer starts only via resetTimeout after turn complete. */
    timeoutMs?: number
    onTimeout?: () => void
  }
): {
  promise: Promise<TaskEvidencePacket>
  cancel: () => void
  resetTimeout: (timeoutMs: number) => void
} {
  // Do NOT arm a wall-clock kill when the task starts. Active turns are guarded by
  // ProgressGuard (60min idle stall). This wait only times out after the turn
  // completes without report_task_result (see resetTimeout → grace).
  // Test override shortens post-complete grace only — never mid-turn kill.
  const initialTimeoutMs = options?.timeoutMs ?? null
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  let rejectPromise: ((error: Error) => void) | undefined
  let settled = false

  const cleanup = (): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
    unregisterTaskMcpSession(sessionId)
  }

  const scheduleTimeout = (timeoutMs: number): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      cleanup()
      options?.onTimeout?.()
      rejectPromise?.(
        createTurnError('task.evidence_timeout', {
          params: { taskId },
          detail: 'Timed out waiting for report_task_result after turn completed'
        })
      )
    }, timeoutMs)
  }

  const promise = new Promise<TaskEvidencePacket>((resolve, reject) => {
    rejectPromise = reject

    if (initialTimeoutMs != null) {
      scheduleTimeout(initialTimeoutMs)
    }

    onAbort = (): void => {
      // Timeout path settles first then aborts the turn; do not overwrite evidence_timeout.
      if (settled) return
      cleanup()
      reject(createTurnError('job.cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    registerTaskMcpSession({
      sessionId,
      jobId,
      taskId,
      idempotencyKey,
      resolve: (packet) => {
        if (settled) return
        cleanup()
        resolve(packet)
      },
      reject: (error) => {
        if (settled) return
        cleanup()
        reject(error)
      }
    })
  })

  void promise.catch(() => {})

  const cancel = (): void => {
    if (settled) return
    cleanup()
    // Not user cancel — wait was torn down by the executor (turn ended/errored).
    rejectPromise?.(
      createTurnError('task.evidence_missing', {
        params: { taskId },
        detail: 'Evidence wait cancelled by executor'
      })
    )
  }

  const resetTimeout = (timeoutMs: number): void => {
    if (settled) return
    scheduleTimeout(timeoutMs)
  }

  return { promise, cancel, resetTimeout }
}

function buildTaskInfraRecoveryResult(input: {
  items: TaskProgressItemDto[]
  taskId: string
  taskProgress: TaskProgressDto
  plan: SavedJobPlan
  gate: ReturnType<typeof buildGateStates>
  message: string
  error?: unknown
}): ExecuteSingleTaskResult {
  const recovery = resolveTaskInfraRecovery({
    taskId: input.taskId,
    taskProgress: input.taskProgress,
    message: input.message,
    error: input.error
  })
  if (recovery.action === 'infra-retry') {
    const itemsRecovered = applyEvidenceMissInfraRetryItem(
      input.items,
      input.taskId,
      input.message,
      recovery.classification,
      recovery.attempt,
      recovery.maxAttempts
    )
    const taskProgressNext = applyTaskRecoveryGenerationForTask(
      { ...input.taskProgress, tasks: itemsRecovered },
      input.taskId,
      recovery
    )
    const gateNext = rebuildGatePreservingVerification(
      input.plan,
      input.gate,
      taskProgressNext,
      itemsRecovered
    )
    reconcileSliceStatuses(gateNext.slices)
    reconcileMilestoneStatuses(gateNext.milestones, gateNext.slices)
    return {
      kind: 'recovered',
      items: itemsRecovered,
      progressCode: 'execution.recovery_infra_retry',
      progressParams: {
        id: input.taskId,
        attempt: recovery.attempt,
        maxAttempts: recovery.maxAttempts
      },
      plan: input.plan,
      taskProgress: { ...taskProgressNext, tasks: itemsRecovered },
      gate: gateNext,
      delayMs: recovery.delayMs
    }
  }
  const fields = taskErrorFieldsFromDto(recovery.error)
  const itemsFailed = updateTaskItem(input.items, input.taskId, {
    status: 'failed',
    executionStatus: 'failed',
    evidenceStatus: 'not-submitted',
    ...fields
  })
  return {
    kind: 'failed',
    items: itemsFailed,
    lastError: recovery.error,
    progressCode: 'execution.failed',
    progressParams: { id: input.taskId }
  }
}

async function runSliceVerificationResilient(input: {
  jobId: string
  threadId: string
  workspacePath: string
  plan: SavedJobPlan
  slice: GateSliceState
  taskItems: TaskProgressItemDto[]
  taskProgress: TaskProgressDto
  gate: ReturnType<typeof buildGateStates>
  signal: AbortSignal
}): Promise<{
  verification: Awaited<ReturnType<typeof runSliceVerification>>
  taskProgress: TaskProgressDto
}> {
  let progress = input.taskProgress
  while (true) {
    const verification = await runSliceVerification({
      jobId: input.jobId,
      threadId: input.threadId,
      workspacePath: input.workspacePath,
      plan: input.plan,
      slice: input.slice,
      taskItems: input.taskItems,
      signal: input.signal
    })
    if (verification.ok || !verification.infraMiss) {
      return { verification, taskProgress: progress }
    }
    const recovery = resolveVerifierInfraRecovery({
      scope: 'slice',
      id: input.slice.id,
      taskProgress: progress,
      message: verification.message
    })
    if (recovery.action !== 'infra-retry') {
      return { verification, taskProgress: progress }
    }
    progress = withVerifierInfraAttempt(progress, 'slice', input.slice.id, recovery.attempt)
    await persistTaskProgress(
      input.jobId,
      {
        ...progress,
        phase: 'running',
        status: 'running',
        currentIndex: countCompleted(input.taskItems),
        total: input.taskItems.length,
        currentTaskId: null,
        message: null,
        progressCode: 'execution.recovery_infra_retry',
        progressParams: {
          id: input.slice.id,
          attempt: recovery.attempt,
          maxAttempts: recovery.maxAttempts
        },
        tasks: input.taskItems
      },
      undefined,
      input.gate
    )
    await sleepMs(recovery.delayMs)
  }
}

async function runMilestoneVerificationResilient(input: {
  jobId: string
  threadId: string
  workspacePath: string
  plan: SavedJobPlan
  milestone: GateMilestoneState
  slices: GateSliceState[]
  taskItems: TaskProgressItemDto[]
  progressSlices?: TaskProgressSliceDto[] | undefined
  taskProgress: TaskProgressDto
  gate: ReturnType<typeof buildGateStates>
  signal: AbortSignal
}): Promise<{
  verification: Awaited<ReturnType<typeof runMilestoneVerification>>
  taskProgress: TaskProgressDto
}> {
  let progress = input.taskProgress
  while (true) {
    const verification = await runMilestoneVerification({
      jobId: input.jobId,
      threadId: input.threadId,
      workspacePath: input.workspacePath,
      plan: input.plan,
      milestone: input.milestone,
      slices: input.slices,
      taskItems: input.taskItems,
      progressSlices: input.progressSlices,
      signal: input.signal
    })
    if (verification.ok || !verification.infraMiss) {
      return { verification, taskProgress: progress }
    }
    const recovery = resolveVerifierInfraRecovery({
      scope: 'milestone',
      id: input.milestone.id,
      taskProgress: progress,
      message: verification.message
    })
    if (recovery.action !== 'infra-retry') {
      return { verification, taskProgress: progress }
    }
    progress = withVerifierInfraAttempt(progress, 'milestone', input.milestone.id, recovery.attempt)
    await persistTaskProgress(
      input.jobId,
      {
        ...progress,
        phase: 'running',
        status: 'running',
        currentIndex: countCompleted(input.taskItems),
        total: input.taskItems.length,
        currentTaskId: null,
        message: null,
        progressCode: 'execution.recovery_infra_retry',
        progressParams: {
          id: input.milestone.id,
          attempt: recovery.attempt,
          maxAttempts: recovery.maxAttempts
        },
        tasks: input.taskItems
      },
      undefined,
      input.gate
    )
    await sleepMs(recovery.delayMs)
  }
}

async function executeSingleTask(
  _username: string,
  job: ThreadJobDto,
  plan: SavedJobPlan,
  taskId: string,
  items: TaskProgressItemDto[],
  taskProgress: TaskProgressDto,
  gate: ReturnType<typeof buildGateStates>,
  idempotencyKey?: string | null
): Promise<ExecuteSingleTaskResult> {
  const flat = findFlatTask(plan, taskId)
  if (!flat) {
    return {
      kind: 'failed',
      items,
      lastError: createTurnError('turn.unknown', {
        params: { taskId },
        detail: `Task ${taskId} not found in plan`
      }).toDto(),
      progressCode: 'execution.failed',
      progressParams: { id: taskId }
    }
  }

  const coreCode = resolveCoreForTask(job, flat)
  const core = await ensureCoreAvailable(coreCode)
  // Cursor ACP long sessions must stay on a stable job-level runtimeRoot across tasks.
  // Other providers keep per-task isolation for evidence/workdir hygiene.
  const runtimeRoot =
    core.code === 'cursorcli'
      ? ensureJobRuntimeRoot(
          getAppContext().dataDir,
          job.threadId,
          job.id,
          core.code
        )
      : ensureJobTaskRuntimeRoot(
          getAppContext().dataDir,
          job.threadId,
          job.id,
          taskId,
          core.code
        )
  if (core.code === 'cursorcli') {
    ensureCursorAcpRuntimeDirs(runtimeRoot, job.workspacePath ?? '')
  }
  const model = resolveCoreModel(core.code as SupportedCoreCode)

  const sessionId = `task-mcp-${randomUUID()}`
  const jobSignal = executionAbortSignal(job.id)
  const turnAbort = new AbortController()
  const signal = mergeAbortSignals(jobSignal, turnAbort.signal)

  let itemsNext = updateTaskItem(items, taskId, {
    status: 'running',
    executionStatus: 'running',
    coreCode: core.code,
    errorMessage: null
  })

  const referenceIds = flat.referenceIds ?? []
  let localPathById = new Map<string, string>()
  let referenceManifest: Awaited<ReturnType<typeof loadJobReferenceManifestForJob>> = null

  if (referenceIds.length > 0) {
    try {
      referenceManifest = await loadJobReferenceManifestForJob({
        jobId: job.id,
        threadId: job.threadId,
        draftMessageId: job.draftMessageId,
        username: _username
      })
      if (!referenceManifest) {
        throw createTurnError('task.evidence_missing', {
          params: { taskId },
          detail: 'Reference manifest missing; cannot resolve attachment paths'
        })
      }
      localPathById = resolveAssignedReferenceLocalPaths(
        referenceManifest,
        referenceIds,
        job.threadId
      )
    } catch (error) {
      const detail =
        error instanceof ReferenceFileMissingError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Reference file unreadable'
      const fields = taskErrorFields(
        createTurnError('task.evidence_missing', { params: { taskId }, detail })
      )
      const itemsFailed = updateTaskItem(itemsNext, taskId, {
        status: 'failed',
        executionStatus: 'failed',
        ...fields
      })
      return {
        kind: 'failed',
        items: itemsFailed,
        lastError: fields.error,
        progressCode: 'execution.failed',
        progressParams: { id: taskId }
      }
    }
  }

  const stableIdempotencyKey = idempotencyKey?.trim()
  if (!stableIdempotencyKey) {
    throw createTurnError('task.terminal_failure', {
      params: { taskId },
      detail: 'Task attempt is missing its durable idempotency key'
    })
  }
  const mcpUrl = buildTaskWorkerMcpUrl({
    sessionId,
    jobId: job.id,
    taskId,
    idempotencyKey: stableIdempotencyKey
  })
  let evidenceTimedOut = false
  const evidenceWait = startTaskEvidenceWait(
    sessionId,
    job.id,
    taskId,
    stableIdempotencyKey,
    jobSignal,
    {
      onTimeout: () => {
        evidenceTimedOut = true
        turnAbort.abort(
          createTurnError('task.evidence_timeout', {
            params: { taskId },
            detail: 'Timed out waiting for report_task_result after turn completed'
          })
        )
      }
    }
  )
  const assignedReferencesMarkdown =
    referenceIds.length > 0 && referenceManifest
      ? buildAssignedReferenceCorpusMarkdown({
          manifest: referenceManifest,
          referenceIds,
          referenceReason: flat.referenceReason,
          localPathById
        })
      : ''
  const readRoots =
    referenceIds.length > 0 && referenceManifest
      ? resolveTaskReferenceReadRoots({
          workspaceRoot: job.workspacePath ?? '',
          manifest: referenceManifest,
          taskReferenceIds: referenceIds
        })
      : []

  try {
    const { enterWorkspaceLeaseContext } = await import('./workspace-lease-context')
    const { acquireWorkspaceLease } = await import('./workspace-lease-store')
    const runId = getExecutionRunContext()?.runId ?? null
    const lease = acquireWorkspaceLease({
      workspacePath: job.workspacePath ?? '',
      ownerKind: 'thread_job',
      ownerId: job.id,
      runId
    })
    if (!lease) {
      throw createTurnError('workspace.lease_lost', {
        detail: 'Workspace lease is not held by this run'
      })
    }
    enterWorkspaceLeaseContext({
      leaseId: lease.leaseId,
      ownerKind: 'thread_job',
      ownerId: job.id
    })

    for await (const chunk of streamAgentTurn({
      role: 'task-worker',
      provider: core.code as SupportedCoreCode,
      workspaceRoot: job.workspacePath ?? '',
      runtimeRoot,
      readRoots,
      prompt: buildTaskWorkerUserMessage({
        taskTitle: flat.title,
        taskDescription: flat.description,
        successCriteria: flat.successCriteria ?? '',
        contextMarkdown: flat.contextMarkdown,
        workspacePath: job.workspacePath ?? '',
        assignedReferencesMarkdown
      }),
      model,
      systemPrompt: TASK_EXECUTION_SYSTEM_PROMPT,
      mcpUrl,
      signal,
      jobId: job.id,
      idempotencyKey: stableIdempotencyKey
    })) {
      if (chunk.type === 'completed') {
        evidenceWait.resetTimeout(getTaskEvidenceWaitTimeoutForTests() ?? TASK_EVIDENCE_GRACE_MS)
        if (chunk.partial) {
          memoryDebug('executeSingleTask: partial turn completed, preserving evidence wait', {
            jobId: job.id,
            taskId,
            replyChars: chunk.reply.length
          })
        }
        break
      }
      if (shouldStopExecution(job.id) === 'cancel') {
        throw JOB_CANCELLED
      }
      if (shouldStopExecution(job.id) === 'pause') {
        throw JOB_PAUSED
      }
    }
  } catch (error) {
    evidenceWait.cancel()
    const stop = shouldStopExecution(job.id)
    if (stop === 'pause') {
      const paused = taskErrorFields(JOB_PAUSED)
      itemsNext = updateTaskItem(itemsNext, taskId, {
        status: 'queued',
        executionStatus: 'queued',
        ...paused
      })
      return {
        kind: 'paused',
        items: itemsNext,
        lastError: paused.error,
        taskProgress: { ...taskProgress, tasks: itemsNext }
      }
    }
    if (stop === 'cancel') {
      const cancelled = taskErrorFields(JOB_CANCELLED)
      itemsNext = updateTaskItem(itemsNext, taskId, {
        status: 'queued',
        executionStatus: 'queued',
        ...cancelled
      })
      return {
        kind: 'paused',
        items: itemsNext,
        lastError: cancelled.error,
        taskProgress: { ...taskProgress, tasks: itemsNext }
      }
    }

    // FIX-PLAN F3-C (§8.4): app shutdown aborted the turn. Distinguish from generic failure — leave
    // the task queued and the Job auto-recoverable instead of mapping to a task/job failure.
    if (isDraining()) {
      itemsNext = updateTaskItem(itemsNext, taskId, {
        status: 'queued',
        executionStatus: 'queued',
        errorMessage: null
      })
      return { kind: 'interrupted', items: itemsNext }
    }

    if (isTurnError(error) && error.code === 'workspace.lease_lost') {
      itemsNext = updateTaskItem(itemsNext, taskId, {
        status: 'queued',
        executionStatus: 'queued',
        errorMessage: null
      })
      return { kind: 'interrupted', items: itemsNext }
    }

    // Evidence wait timeout aborts the agent turn; do not mislabel AbortError as user cancel.
    if (evidenceTimedOut) {
      return buildTaskInfraRecoveryResult({
        items: itemsNext,
        taskId,
        taskProgress,
        plan,
        gate,
        message: 'Timed out waiting for report_task_result',
        error: createTurnError('task.evidence_timeout', {
          params: { taskId },
          detail: 'Timed out waiting for report_task_result'
        })
      })
    }

    const message = turnErrorMessage(error)
    if (isRetryableTurnError(error) || isInfraTurnError(error)) {
      return buildTaskInfraRecoveryResult({
        items: itemsNext,
        taskId,
        taskProgress,
        plan,
        gate,
        message,
        error
      })
    }
    const mapped = taskFailureFromSandboxError(error, {
      phase: 'running',
      status: 'running',
      currentIndex: countCompleted(itemsNext),
      total: itemsNext.length,
      currentTaskId: taskId,
      tasks: itemsNext
    })
    const failedFields = taskErrorFieldsFromDto(mapped.lastError)
    itemsNext = updateTaskItem(itemsNext, taskId, {
      status: 'failed',
      executionStatus: 'failed',
      ...failedFields
    })
    return {
      kind: 'failed',
      items: itemsNext,
      lastError: mapped.lastError,
      progressCode: 'execution.failed',
      progressParams: { id: taskId }
    }
  }

  try {
    const packet = await evidenceWait.promise
    return processTaskEvidenceOutcome({
      items: itemsNext,
      taskId,
      packet,
      plan,
      taskProgress,
      gate
    })
  } catch (error) {
    const message = turnErrorMessage(error)
    evidenceWait.cancel()
    return buildTaskInfraRecoveryResult({
      items: itemsNext,
      taskId,
      taskProgress,
      plan,
      gate,
      message,
      error
    })
  }
}

async function finalizeExecutionPause(
  jobId: string,
  taskProgress: TaskProgressDto,
  items: TaskProgressItemDto[],
  gate: ReturnType<typeof buildGateStates>
): Promise<void> {
  const paused = taskErrorFields(JOB_PAUSED)
  const row = await loadJobRow(jobId)
  const continueAfter = row?.continueAfterPause === 1
  const username = row?.username

  await persistTaskProgress(
    jobId,
    {
      ...taskProgress,
      tasks: items,
      currentTaskId: null,
      message: null,
      progressParams: null
    },
    {
      status: 'paused',
      lastError: paused.error,
      suspensionKind: parseSuspensionKind(row?.suspensionKind) ?? 'user_pause',
      continueAfterPause: false,
      recoveryReason: null
    },
    gate,
    'snapshot'
  )
  pauseJobExecution(jobId)

  if (continueAfter && username) {
    const { authorizeUncertainTaskAttemptReplayForJob } = await import('./task-attempts')
    authorizeUncertainTaskAttemptReplayForJob(jobId)
    const { continueJob } = await import('./controls')
    await continueJob(username, jobId).catch((error) => {
      console.warn('[jobs] continue_after_pause failed after pause settle', jobId, error)
    })
  }
}

interface ExecutionLoopState {
  jobId: string
  username: string
  job: ThreadJobDto
  plan: SavedJobPlan
  items: TaskProgressItemDto[]
  taskProgress: TaskProgressDto
  gate: ReturnType<typeof buildGateStates>
  dataDir: string
  initialStatus: string
}

async function initializeExecutionState(
  username: string,
  jobId: string
): Promise<ExecutionLoopState | null> {
  const row = await loadJobRow(jobId)
  if (!row) return null

  const plan = await loadJobPlan(getDb(), jobId)
  if (!plan?.tasks?.length) return null

  let job = await getUserJob(username, jobId)
  if (!job) return null

  if (job.status === 'paused' || job.status === 'cancelled') return null

  const initialStatus = job.status
  if (job.status === 'pausing') {
    getAppContext().executionRuntime.setControl(jobId, 'paused')
  } else {
    await updateExecutionJobRow(jobId, { status: 'running' })
  }
  refreshExecutionLease(jobId)
  job = (await getUserJob(username, jobId)) ?? job

  let items = taskItemsFromProgress(job.taskProgress)
  let taskProgress: TaskProgressDto = { ...job.taskProgress, tasks: items }
  if (items.length === 0) {
    items = plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: 'queued' as const,
      abilityCode: task.abilityCode,
      executionStatus: 'queued',
      evidenceStatus: null,
      errorMessage: null,
      coreCode: null
    }))
  }

  const gate = buildGateStates(plan)
  applyVerificationProgress(gate.slices, gate.milestones, job.taskProgress)
  const dataDir = getAppContext().dataDir

  const recovered =
    resetInterruptedGateVerification(gate.slices, gate.milestones) ||
    resetInterruptedRunningTasks(items)
  if (recovered) {
    applyTaskProgressToGate(gate.tasks, items)
    reconcileSliceStatuses(gate.slices)
    reconcileMilestoneStatuses(gate.milestones, gate.slices)
    taskProgress = {
      ...taskProgress,
      phase: 'running',
      status: 'running',
      currentIndex: countCompleted(items),
      total: items.length,
      currentTaskId: null,
      message: null,
      progressCode: 'execution.resuming',
      progressParams: null,
      tasks: items
    }
    await persistTaskProgress(
      jobId,
      taskProgress,
      initialStatus === 'pausing' ? undefined : { status: 'running', lastError: null },
      gate
    )
  }

  return { jobId, username, job, plan, items, taskProgress, gate, dataDir, initialStatus }
}

function buildCompletedProgress(
  items: TaskProgressItemDto[],
  prior?: TaskProgressDto
): TaskProgressDto {
  return {
    phase: 'completed' as const,
    status: 'completed' as const,
    currentIndex: items.length,
    total: items.length,
    currentTaskId: null,
    message: null,
    progressCode: 'execution.completed',
    progressParams: { done: items.length, total: items.length },
    tasks: items,
    slices: prior?.slices,
    milestones: prior?.milestones,
    repairGenerations: prior?.repairGenerations,
    verificationAttempts: prior?.verificationAttempts,
    verificationBundleHashes: prior?.verificationBundleHashes
  }
}

async function handleWorkflowCompletion(
  jobId: string,
  items: TaskProgressItemDto[],
  gate: ReturnType<typeof buildGateStates>,
  prior?: TaskProgressDto
): Promise<{ taskProgress: TaskProgressDto; items: TaskProgressItemDto[]; done: boolean }> {
  const completedProgress = buildCompletedProgress(items, prior)
  const completed = await persistTaskProgress(
    jobId,
    completedProgress,
    { status: 'completed', lastError: null },
    gate,
    'terminal'
  )
  if (completed) {
    items = slimTaskProgressItemsForRuntime(items)
  }
  return { taskProgress: completedProgress, items, done: true }
}

type GateStates = ReturnType<typeof buildGateStates>

interface ExecutionLoopMutable {
  jobId: string
  username: string
  job: ThreadJobDto
  plan: SavedJobPlan
  items: TaskProgressItemDto[]
  taskProgress: TaskProgressDto
  gate: GateStates
  dataDir: string
}

type LoopStepAction = 'continue' | 'return' | 'skip'

function syncLoopState(
  ctx: ExecutionLoopMutable,
  next: {
    plan?: SavedJobPlan
    items?: TaskProgressItemDto[]
    taskProgress?: TaskProgressDto
    gate?: GateStates
    job?: ThreadJobDto
  }
): void {
  if (next.plan !== undefined) ctx.plan = next.plan
  if (next.items !== undefined) ctx.items = next.items
  if (next.taskProgress !== undefined) ctx.taskProgress = next.taskProgress
  if (next.gate !== undefined) ctx.gate = next.gate
  if (next.job !== undefined) ctx.job = next.job
}

async function processSliceVerificationStep(ctx: ExecutionLoopMutable): Promise<LoopStepAction> {
  const jobId = ctx.jobId
  let { plan, items, taskProgress, gate } = ctx
  const { job, dataDir } = ctx
  const sliceToVerify = findSliceReadyForVerification(gate.slices)
  if (!sliceToVerify) return 'skip'

  const slicePreflight = preflightSliceTaskEvidence(plan, sliceToVerify.id, items)
  if (!slicePreflight.ok) {
    for (const taskId of slicePreflight.missingTaskIds) {
      items = updateTaskItem(items, taskId, {
        status: 'queued',
        executionStatus: 'queued',
        evidenceStatus: 'incomplete',
        evidence: null,
        errorMessage: null,
        error: createTurnError('task.evidence_missing', {
          params: { taskId }
        }).toDto()
      })
    }
    sliceToVerify.runtimeStatus = null
    sliceToVerify.verificationStatus = null
    taskProgress = {
      ...taskProgress,
      phase: 'running',
      status: 'running',
      currentIndex: countCompleted(items),
      total: items.length,
      currentTaskId: null,
      message: null,
      progressCode: 'execution.evidence_incomplete',
      progressParams: { sliceId: sliceToVerify.id },
      tasks: items
    }
    await persistTaskProgress(jobId, taskProgress, undefined, gate)
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'continue'
  }

  const sliceBundleHash = computeSliceEvidenceBundleHash(plan, sliceToVerify.id, items, dataDir)
  const sliceAttemptGuard = guardVerificationAttempt({
    progress: taskProgress,
    scope: 'slice',
    id: sliceToVerify.id,
    bundleHash: sliceBundleHash
  })
  if (!sliceAttemptGuard.ok) {
    sliceToVerify.runtimeStatus = 'verification-blocked'
    sliceToVerify.verificationStatus = 'blocked'
    await failJobWithProgress(
      jobId,
      taskProgress,
      items,
      gate,
      sliceAttemptGuard.progressCode,
      sliceAttemptGuard.progressParams,
      taskTerminalError(sliceToVerify.id, sliceAttemptGuard.reason)
    )
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'return'
  }

  const signal = executionAbortSignal(jobId)
  sliceToVerify.runtimeStatus = 'verifying'
  await persistTaskProgress(
    jobId,
    {
      ...taskProgress,
      phase: 'running',
      status: 'running',
      currentIndex: countCompleted(items),
      total: items.length,
      currentTaskId: null,
      message: null,
      progressCode: 'execution.verifying_slice',
      progressParams: { id: sliceToVerify.id },
      tasks: items
    },
    undefined,
    gate
  )

  const verificationResult = await runSliceVerificationResilient({
    jobId,
    threadId: job.threadId,
    workspacePath: job.workspacePath ?? '',
    plan,
    slice: sliceToVerify,
    taskItems: items,
    taskProgress,
    gate,
    signal
  })
  taskProgress = verificationResult.taskProgress
  const verification = verificationResult.verification

  if (!verification.ok) {
    if (verification.verdict?.status === 'needs-repair') {
      const repair = await handleSliceNeedsRepair({
        jobId,
        plan,
        sliceId: sliceToVerify.id,
        verdict: verification.verdict,
        items,
        taskProgress,
        gate
      })
      if (!repair.ok) {
        await failJobWithProgress(
          jobId,
          taskProgress,
          items,
          gate,
          repair.progressCode,
          repair.progressParams,
          taskTerminalError(sliceToVerify.id)
        )
        syncLoopState(ctx, { plan, items, taskProgress, gate, job })
        return 'return'
      }
      plan = repair.plan
      items = repair.items
      taskProgress = repair.taskProgress
      gate = repair.gate
      syncLoopState(ctx, { plan, items, taskProgress, gate, job })
      return 'continue'
    }

    if (verification.verdict?.status === 'blocked') {
      sliceToVerify.runtimeStatus = 'verification-blocked'
      sliceToVerify.verificationStatus = 'blocked'
      if (verification.verdict) {
        taskProgress = {
          ...taskProgress,
          slices: upsertSliceVerdict(
            taskProgress.slices,
            sliceToVerify.id,
            toSliceVerificationRecord(verification.verdict)
          ),
          tasks: items
        }
      }
      await failJobWithProgress(
        jobId,
        taskProgress,
        items,
        gate,
        'execution.slice_blocked',
        { id: sliceToVerify.id },
        taskTerminalError(sliceToVerify.id, verification.message)
      )
      syncLoopState(ctx, { plan, items, taskProgress, gate, job })
      return 'return'
    }

    if (verification.verdict?.status === 'inconclusive') {
      const nextAttempt = verificationAttemptCount(taskProgress, 'slice', sliceToVerify.id) + 1
      if (verification.verdict) {
        taskProgress = {
          ...taskProgress,
          slices: upsertSliceVerdict(
            taskProgress.slices,
            sliceToVerify.id,
            toSliceVerificationRecord(verification.verdict)
          ),
          tasks: items
        }
      }

      if (nextAttempt >= MAX_VERIFICATION_ATTEMPTS) {
        sliceToVerify.runtimeStatus = 'verification-blocked'
        sliceToVerify.verificationStatus = 'inconclusive'
        await failJobWithProgress(
          jobId,
          taskProgress,
          items,
          gate,
          'execution.slice_inconclusive_exhausted',
          { id: sliceToVerify.id, maxAttempts: MAX_VERIFICATION_ATTEMPTS },
          taskTerminalError(sliceToVerify.id, verification.message)
        )
        syncLoopState(ctx, { plan, items, taskProgress, gate, job })
        return 'return'
      }

      const repair = await handleSliceEvidenceRepair({
        jobId,
        plan,
        sliceId: sliceToVerify.id,
        reason: verification.message,
        attempt: nextAttempt,
        bundleHash: sliceBundleHash,
        items,
        taskProgress,
        gate
      })
      if (!repair.ok) {
        await failJobWithProgress(
          jobId,
          taskProgress,
          items,
          gate,
          repair.progressCode,
          repair.progressParams,
          taskTerminalError(sliceToVerify.id)
        )
        syncLoopState(ctx, { plan, items, taskProgress, gate, job })
        return 'return'
      }
      plan = repair.plan
      items = repair.items
      taskProgress = repair.taskProgress
      gate = repair.gate
      syncLoopState(ctx, { plan, items, taskProgress, gate, job })
      return 'continue'
    }

    const failed = await persistTaskProgress(
      jobId,
      {
        phase: 'failed',
        status: 'failed',
        currentIndex: countCompleted(items),
        total: items.length,
        currentTaskId: null,
        message: null,
        progressCode: 'execution.slice_blocked',
        progressParams: { id: sliceToVerify.id },
        tasks: items
      },
      {
        status: 'failed',
        lastError: taskTerminalError(sliceToVerify.id, verification.message)
      },
      gate,
      'terminal'
    )
    if (failed) {
      items = slimTaskProgressItemsForRuntime(items)
    }
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'return'
  }

  sliceToVerify.runtimeStatus = 'progress-ok'
  sliceToVerify.verificationStatus = 'passed'
  reconcileMilestoneStatuses(gate.milestones, gate.slices)
  taskProgress = {
    ...taskProgress,
    slices: verification.verdict
      ? upsertSliceVerdict(
          taskProgress.slices,
          sliceToVerify.id,
          toSliceVerificationRecord(verification.verdict)
        )
      : taskProgress.slices,
    phase: 'running',
    status: 'running',
    currentIndex: countCompleted(items),
    total: items.length,
    currentTaskId: null,
    message: null,
    progressCode: 'execution.slice_accepted',
    progressParams: { id: sliceToVerify.id },
    tasks: items
  }
  await persistTaskProgress(jobId, taskProgress, undefined, gate)
  await cleanupDurableTaskRuntime(dataDir, job.threadId, jobId, `verify-${sliceToVerify.id}`)
  syncLoopState(ctx, { plan, items, taskProgress, gate, job })
  return 'continue'
}

async function processMilestoneVerificationStep(
  ctx: ExecutionLoopMutable
): Promise<LoopStepAction> {
  const jobId = ctx.jobId
  let { plan, items, taskProgress, gate } = ctx
  const { job, dataDir } = ctx
  const milestoneToVerify = findMilestoneReadyForVerification(gate.milestones, gate.slices)
  if (!milestoneToVerify) return 'skip'

  const sliceVerdictMap = Object.fromEntries(
    (taskProgress.slices ?? []).filter((row) => row.verdict).map((row) => [row.id, row.verdict])
  )
  const milestonePreflight = preflightMilestoneSliceVerdicts(
    milestoneToVerify.sliceIds,
    sliceVerdictMap
  )
  if (!milestonePreflight.ok) {
    milestoneToVerify.verificationStatus = 'ready-for-verification'
    taskProgress = {
      ...taskProgress,
      phase: 'running',
      status: 'running',
      currentIndex: countCompleted(items),
      total: items.length,
      currentTaskId: null,
      message: null,
      progressCode: 'execution.evidence_incomplete',
      progressParams: { milestoneId: milestoneToVerify.id },
      tasks: items
    }
    await persistTaskProgress(jobId, taskProgress, undefined, gate)
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'continue'
  }

  const milestoneBundleHash = computeMilestoneEvidenceBundleHash(
    plan,
    milestoneToVerify.id,
    items,
    taskProgress.slices,
    dataDir
  )
  const milestoneAttemptGuard = guardVerificationAttempt({
    progress: taskProgress,
    scope: 'milestone',
    id: milestoneToVerify.id,
    bundleHash: milestoneBundleHash
  })
  if (!milestoneAttemptGuard.ok) {
    milestoneToVerify.verificationStatus = 'blocked'
    await failJobWithProgress(
      jobId,
      taskProgress,
      items,
      gate,
      milestoneAttemptGuard.progressCode,
      milestoneAttemptGuard.progressParams,
      taskTerminalError(milestoneToVerify.id, milestoneAttemptGuard.reason)
    )
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'return'
  }

  const signal = executionAbortSignal(jobId)
  milestoneToVerify.verificationStatus = 'verifying'
  await persistTaskProgress(
    jobId,
    {
      ...taskProgress,
      phase: 'running',
      status: 'running',
      currentIndex: countCompleted(items),
      total: items.length,
      currentTaskId: null,
      message: null,
      progressCode: 'execution.verifying_milestone',
      progressParams: { id: milestoneToVerify.id },
      tasks: items
    },
    undefined,
    gate
  )

  const verificationResult = await runMilestoneVerificationResilient({
    jobId,
    threadId: job.threadId,
    workspacePath: job.workspacePath ?? '',
    plan,
    milestone: milestoneToVerify,
    slices: gate.slices,
    taskItems: items,
    progressSlices: taskProgress.slices,
    taskProgress,
    gate,
    signal
  })
  taskProgress = verificationResult.taskProgress
  const verification = verificationResult.verification

  if (!verification.ok) {
    if (verification.verdict?.status === 'needs-repair') {
      const repair = await handleMilestoneNeedsRepair({
        jobId,
        plan,
        milestoneId: milestoneToVerify.id,
        verdict: verification.verdict,
        items,
        taskProgress,
        gate
      })
      if (!repair.ok) {
        await failJobWithProgress(
          jobId,
          taskProgress,
          items,
          gate,
          repair.progressCode,
          repair.progressParams,
          taskTerminalError(milestoneToVerify.id)
        )
        syncLoopState(ctx, { plan, items, taskProgress, gate, job })
        return 'return'
      }
      plan = repair.plan
      items = repair.items
      taskProgress = repair.taskProgress
      gate = repair.gate
      syncLoopState(ctx, { plan, items, taskProgress, gate, job })
      return 'continue'
    }

    if (verification.verdict?.status === 'blocked') {
      milestoneToVerify.verificationStatus = 'blocked'
      await failJobWithProgress(
        jobId,
        taskProgress,
        items,
        gate,
        'execution.milestone_blocked',
        { id: milestoneToVerify.id },
        taskTerminalError(milestoneToVerify.id, verification.message)
      )
      syncLoopState(ctx, { plan, items, taskProgress, gate, job })
      return 'return'
    }

    if (verification.verdict?.status === 'inconclusive') {
      const nextAttempt =
        verificationAttemptCount(taskProgress, 'milestone', milestoneToVerify.id) + 1

      if (nextAttempt >= MAX_VERIFICATION_ATTEMPTS) {
        milestoneToVerify.verificationStatus = 'inconclusive'
        await failJobWithProgress(
          jobId,
          taskProgress,
          items,
          gate,
          'execution.milestone_inconclusive_exhausted',
          { id: milestoneToVerify.id, maxAttempts: MAX_VERIFICATION_ATTEMPTS },
          taskTerminalError(milestoneToVerify.id, verification.message)
        )
        syncLoopState(ctx, { plan, items, taskProgress, gate, job })
        return 'return'
      }

      const repair = await handleMilestoneEvidenceRepair({
        jobId,
        plan,
        milestoneId: milestoneToVerify.id,
        reason: verification.message,
        attempt: nextAttempt,
        bundleHash: milestoneBundleHash,
        items,
        taskProgress,
        gate
      })
      if (!repair.ok) {
        await failJobWithProgress(
          jobId,
          taskProgress,
          items,
          gate,
          repair.progressCode,
          repair.progressParams,
          taskTerminalError(milestoneToVerify.id)
        )
        syncLoopState(ctx, { plan, items, taskProgress, gate, job })
        return 'return'
      }
      plan = repair.plan
      items = repair.items
      taskProgress = repair.taskProgress
      gate = repair.gate
      syncLoopState(ctx, { plan, items, taskProgress, gate, job })
      return 'continue'
    }

    await failJobWithProgress(
      jobId,
      taskProgress,
      items,
      gate,
      'execution.milestone_blocked',
      { id: milestoneToVerify.id },
      taskTerminalError(milestoneToVerify.id, verification.message)
    )
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'return'
  }

  milestoneToVerify.verificationStatus = 'passed'
  taskProgress = {
    ...taskProgress,
    phase: 'running',
    status: 'running',
    currentIndex: countCompleted(items),
    total: items.length,
    currentTaskId: null,
    message: null,
    progressCode: 'execution.milestone_accepted',
    progressParams: { id: milestoneToVerify.id },
    tasks: items
  }
  await persistTaskProgress(jobId, taskProgress, undefined, gate)
  await cleanupDurableTaskRuntime(dataDir, job.threadId, jobId, `verify-${milestoneToVerify.id}`)
  syncLoopState(ctx, { plan, items, taskProgress, gate, job })
  return 'continue'
}

async function processNextTaskStep(ctx: ExecutionLoopMutable): Promise<LoopStepAction> {
  const jobId = ctx.jobId
  const username = ctx.username
  let { plan, items, taskProgress, gate, job } = ctx
  const next = findNextReadyTask(gate.slices, gate.tasks)
  if (!next) {
    const anyFailed = items.some((item) => item.status === 'failed')
    const workflowError = createTurnError(
      anyFailed ? 'workflow.failed_block' : 'workflow.deadlock'
    ).toDto()
    const failedProgress: TaskProgressDto = {
      phase: 'failed',
      status: 'failed',
      currentIndex: countCompleted(items),
      total: items.length,
      currentTaskId: null,
      message: null,
      progressCode: anyFailed ? 'execution.workflow_failed_block' : 'execution.workflow_deadlock',
      progressParams: null,
      tasks: items
    }
    taskProgress = failedProgress
    const failed = await persistTaskProgress(
      jobId,
      failedProgress,
      {
        status: 'failed',
        lastError: workflowError
      },
      gate,
      'terminal'
    )
    if (failed) {
      items = slimTaskProgressItemsForRuntime(items)
    }
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'return'
  }

  // FIX-PLAN F3-B (§8.3) + R1: open a durable attempt before any Provider call. Fail closed on
  // begin errors — never invoke the Provider without an attempt ledger row.
  let attemptNo: number | null = null
  let idempotencyKey: string | null = null
  let providerStartRequired = false
  const runId = getExecutionRunContext()?.runId ?? null
  try {
    const attempt = beginTaskAttempt({
      jobId,
      taskId: next.id,
      runId,
      snapshotPlanRevision: job.snapshotPlanRevision ?? job.planRevision ?? 0
    })
    if (attempt.kind === 'already-completed') {
      items = updateTaskItem(items, next.id, {
        status: 'completed',
        executionStatus: 'completed',
        errorMessage: null
      })
      applyTaskProgressToGate(gate.tasks, items)
      reconcileSliceStatuses(gate.slices)
      reconcileMilestoneStatuses(gate.milestones, gate.slices)
      const skipProgress: TaskProgressDto = {
        ...taskProgress,
        phase: 'running',
        status: 'running',
        currentIndex: countCompleted(items),
        total: items.length,
        currentTaskId: null,
        message: null,
        progressCode: 'execution.resuming',
        progressParams: null,
        tasks: items
      }
      taskProgress = skipProgress
      await persistTaskProgress(jobId, skipProgress, undefined, gate)
      await cleanupDurableTaskRuntime(ctx.dataDir, job.threadId, jobId, next.id)
      syncLoopState(ctx, { plan, items, taskProgress, gate, job })
      return 'continue'
    }
    if (attempt.kind === 'blocked-uncertain') {
      const detail = `Automatic replay blocked: task attempt ${attempt.attemptNo} has an uncertain side-effect outcome (${attempt.status})`
      await failJobWithProgress(
        jobId,
        taskProgress,
        items,
        gate,
        'execution.failed',
        { id: next.id },
        createTurnError('task.terminal_failure', { detail }).toDto()
      )
      syncLoopState(ctx, { plan, items, taskProgress, gate, job })
      return 'return'
    }
    attemptNo = attempt.attemptNo
    idempotencyKey = attempt.idempotencyKey
    providerStartRequired = attempt.kind === 'started'
  } catch (error) {
    memoryDebug('processNextTaskStep: beginTaskAttempt failed', { jobId, taskId: next.id })
    const detail = error instanceof Error ? error.message : String(error)
    await failJobWithProgress(
      jobId,
      taskProgress,
      items,
      gate,
      'execution.failed',
      { id: next.id },
      createTurnError('task.terminal_failure', {
        detail: `beginTaskAttempt failed: ${detail}`
      }).toDto()
    )
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'return'
  }

  const nextFlat = findFlatTask(plan, next.id)
  if (nextFlat) {
    items = updateTaskItem(items, next.id, {
      status: 'running',
      executionStatus: 'running',
      coreCode: resolveCoreForTask(job, nextFlat)
    })
    applyTaskProgressToGate(gate.tasks, items)
    reconcileSliceStatuses(gate.slices)
    reconcileMilestoneStatuses(gate.milestones, gate.slices)
  }

  const runningProgress: TaskProgressDto = {
    phase: 'running',
    status: 'running',
    currentIndex: countCompleted(items),
    total: items.length,
    currentTaskId: next.id,
    message: null,
    progressCode: 'execution.running_task',
    progressParams: { id: next.id },
    tasks: items
  }
  await persistTaskProgress(jobId, runningProgress, undefined, gate)

  // This transition is the durable at-most-once boundary. If it cannot be persisted, the
  // Provider is never invoked. Once persisted, an unknown result keeps the stable key occupied
  // and a later recovery fails closed instead of replaying arbitrary external side effects.
  if (attemptNo == null) {
    throw new Error('task_attempt.missing_before_provider_start')
  }
  if (providerStartRequired) {
    markTaskAttemptProviderStarted({ jobId, taskId: next.id, attemptNo })
  }

  const result = await executeSingleTask(
    username,
    job,
    plan,
    next.id,
    items,
    taskProgress,
    gate,
    idempotencyKey
  )
  const fullItems = result.items

  if (result.kind === 'recovered') {
    plan = result.plan
    taskProgress = result.taskProgress
    gate = result.gate
    const recoveredProgress: TaskProgressDto = {
      ...taskProgress,
      phase: 'running',
      status: 'running',
      currentIndex: countCompleted(fullItems),
      total: fullItems.length,
      currentTaskId: null,
      message: null,
      progressCode: result.progressCode,
      progressParams: result.progressParams ?? null,
      tasks: fullItems
    }
    await persistPlanAndProgress(
      jobId,
      plan,
      recoveredProgress,
      {
        status: 'running',
        lastError: null
      },
      gate
    )
    if (result.delayMs) {
      await sleepMs(result.delayMs)
    }
    items = slimTaskProgressItemsForRuntime(fullItems)
    job = (await getUserJob(username, jobId)) ?? job
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'continue'
  }

  if (result.kind === 'paused') {
    const pausedProgress: TaskProgressDto = {
      ...result.taskProgress,
      phase: 'running',
      status: 'running',
      currentIndex: countCompleted(fullItems),
      total: fullItems.length,
      currentTaskId: null,
      message: null,
      progressParams: null,
      tasks: fullItems
    }
    await persistTaskProgress(
      jobId,
      pausedProgress,
      {
        status: 'paused',
        lastError: result.lastError
      },
      gate,
      'snapshot'
    )
    pauseJobExecution(jobId)
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'return'
  }

  if (result.kind === 'interrupted') {
    // App shutdown at a safe checkpoint: leave the Job `running` (recoverable). Do not persist a
    // paused/failed status. The task attempt is marked interrupted by the shutdown coordinator.
    items = slimTaskProgressItemsForRuntime(result.items)
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'return'
  }

  if (result.kind === 'failed' && shouldStopExecution(jobId) === 'pause') {
    const nextAttempt = readPausingAttempt(taskProgress, jobId) + 1
    taskProgress = withPausingAttempt(taskProgress, jobId, nextAttempt)
    if (nextAttempt >= MAX_PAUSING_TURN_ATTEMPTS) {
      await failJobWithProgress(
        jobId,
        taskProgress,
        fullItems,
        gate,
        'execution.pausing_exhausted',
        { maxAttempts: MAX_PAUSING_TURN_ATTEMPTS },
        createTurnError('task.terminal_failure', {
          detail: `Pause timed out after ${MAX_PAUSING_TURN_ATTEMPTS} attempts`
        }).toDto()
      )
      syncLoopState(ctx, { plan, items, taskProgress, gate, job })
      return 'return'
    }
    items = slimTaskProgressItemsForRuntime(fullItems)
    taskProgress = { ...taskProgress, tasks: fullItems }
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'continue'
  }

  const failed = result.kind === 'failed'
  if (!failed && shouldStopExecution(jobId) === 'pause') {
    const completedProgress: TaskProgressDto = {
      phase: 'running',
      status: 'running',
      currentIndex: countCompleted(fullItems),
      total: fullItems.length,
      currentTaskId: null,
      message: null,
      progressCode: 'execution.completed',
      progressParams: {
        done: countCompleted(fullItems),
        total: fullItems.length
      },
      tasks: fullItems
    }
    taskProgress = completedProgress
    // The task itself finished successfully before the pause landed: commit the attempt so a
    // resume never re-runs it (FIX-PLAN F3-B / R1). Commit failures must not advance progress.
    if (attemptNo != null) {
      const evidence = fullItems.find((item) => item.id === next.id)?.evidence ?? null
      commitCompletedTaskAttempt({ jobId, taskId: next.id, attemptNo, result: evidence })
    }
    items = slimTaskProgressItemsForRuntime(fullItems)
    await finalizeExecutionPause(jobId, taskProgress, items, gate)
    await cleanupDurableTaskRuntime(ctx.dataDir, job.threadId, jobId, next.id)
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'return'
  }

  // FIX-PLAN F3-B (§8.3) + R1: commit task success atomically, or record the failed attempt.
  // Do not swallow commit failures — memory/job progress must not advance as completed.
  if (attemptNo != null) {
    if (result.kind === 'failed') {
      markTaskAttemptFailed({
        jobId,
        taskId: next.id,
        attemptNo,
        errorJson: JSON.stringify(result.lastError)
      })
    } else if (result.kind === 'completed') {
      const evidence = fullItems.find((item) => item.id === next.id)?.evidence ?? null
      commitCompletedTaskAttempt({ jobId, taskId: next.id, attemptNo, result: evidence })
    }
  }

  const afterProgress: TaskProgressDto = {
    phase: failed ? 'failed' : 'running',
    status: failed ? 'failed' : 'running',
    currentIndex: countCompleted(fullItems),
    total: fullItems.length,
    currentTaskId: null,
    message: null,
    progressCode: failed ? (result.progressCode ?? 'execution.failed') : 'execution.completed',
    progressParams: failed
      ? (result.progressParams ?? { id: 'unknown' })
      : {
          done: countCompleted(fullItems),
          total: fullItems.length
        },
    tasks: fullItems
  }
  await persistTaskProgress(
    jobId,
    afterProgress,
    {
      status: failed ? 'failed' : 'running',
      lastError: failed ? result.lastError : null
    },
    gate,
    failed ? 'terminal' : 'delta'
  )

  if (result.kind === 'completed') {
    await cleanupDurableTaskRuntime(ctx.dataDir, job.threadId, jobId, next.id)
  }

  items = slimTaskProgressItemsForRuntime(fullItems)
  if (failed) {
    syncLoopState(ctx, { plan, items, taskProgress, gate, job })
    return 'return'
  }

  job = (await getUserJob(username, jobId)) ?? job
  syncLoopState(ctx, { plan, items, taskProgress, gate, job })
  return 'continue'
}

async function runExecutionLoop(username: string, jobId: string): Promise<void> {
  const state = await initializeExecutionState(username, jobId)
  if (!state) return

  const ctx: ExecutionLoopMutable = {
    jobId: state.jobId,
    username: state.username,
    job: state.job,
    plan: state.plan,
    items: state.items,
    taskProgress: state.taskProgress,
    gate: state.gate,
    dataDir: state.dataDir
  }

  while (true) {
    refreshExecutionLease(jobId)

    // FIX-PLAN F3-C (§8.4): app shutdown — stop between tasks at a safe checkpoint and leave the
    // Job auto-recoverable `running`; the shutdown coordinator interrupts the attempt + releases.
    if (isDraining()) {
      try {
        const { markRunningAttemptsInterruptedForJob } = await import('./task-attempts')
        markRunningAttemptsInterruptedForJob(jobId)
      } catch (error) {
        void error
      }
      return
    }

    const stop = shouldStopExecution(jobId)
    if (stop === 'cancel') return
    if (stop === 'pause') {
      await finalizeExecutionPause(jobId, ctx.taskProgress, ctx.items, ctx.gate)
      return
    }

    applyTaskProgressToGate(ctx.gate.tasks, ctx.items)
    reconcileSliceStatuses(ctx.gate.slices)
    reconcileMilestoneStatuses(ctx.gate.milestones, ctx.gate.slices)

    if (isWorkflowComplete(ctx.gate.milestones, ctx.gate.slices)) {
      const result = await handleWorkflowCompletion(jobId, ctx.items, ctx.gate, ctx.taskProgress)
      ctx.taskProgress = result.taskProgress
      ctx.items = result.items
      return
    }

    const sliceAction = await processSliceVerificationStep(ctx)
    if (sliceAction === 'return') return
    if (sliceAction === 'continue') continue

    const milestoneAction = await processMilestoneVerificationStep(ctx)
    if (milestoneAction === 'return') return
    if (milestoneAction === 'continue') continue

    const taskAction = await processNextTaskStep(ctx)
    if (taskAction === 'return') return
  }
}

export function scheduleJobExecution(
  username: string,
  jobId: string,
  preclaimedSlot?: { runId: string; signal: AbortSignal }
): void {
  if (!markJobExecuting(jobId, username)) {
    // A loop is already active for this job. If we arrived with a pre-claimed
    // slot (should not happen: advanceExecutionQueue guards this), release it
    // and revert to pending so we never leave an orphan run/slot behind.
    if (preclaimedSlot) {
      void (async () => {
        const { releaseWorkloadSlot } = await import('./workload-slot-store')
        await releaseWorkloadSlot(preclaimedSlot.runId, {
          reason: 'loop_already_active',
          skipQueueAdvance: true
        }).catch(() => {})
        const reverted = await updateJobRowForSnapshot(jobId, {
          status: 'pending',
          lastError: null
        }).catch(() => null)
        if (reverted) {
          emitJobEvent(jobId, { event: 'job_snapshot', data: { job: reverted } })
        }
      })()
    }
    return
  }
  void (async () => {
    let executionRunId: string | undefined
    let executionOutcome: import('./run-lifecycle').ExecutionRunOutcome = 'success'
    try {
      // Fresh pending→running promotions arrive with an already-claimed slot
      // (single atomic claim). Resume/continue/restart paths still claim here.
      let slot: { runId: string; signal: AbortSignal } | null | undefined = preclaimedSlot
      if (!slot) {
        const { claimExecutionWorkloadSlot } = await import('./workload-slot-store')
        slot = await claimExecutionWorkloadSlot(username, jobId)
      }
      if (!slot) {
        memoryDebug('scheduleJobExecution: no execution slot, reverting to pending', { jobId })
        const reverted = await updateJobRowForSnapshot(jobId, {
          status: 'pending',
          lastError: null
        })
        if (reverted) {
          emitJobEvent(jobId, { event: 'job_snapshot', data: { job: reverted } })
        }
        return
      }
      executionRunId = slot.runId

      const currentJob = await getUserJob(username, jobId)
      if (currentJob) {
        const { acquireWorkspaceLease } = await import('./workspace-lease-store')
        const workspaceLease = acquireWorkspaceLease({
          workspacePath: currentJob.workspacePath ?? '',
          ownerKind: 'thread_job',
          ownerId: jobId,
          runId: slot.runId
        })
        if (!workspaceLease) {
          const { releaseWorkloadSlot } = await import('./workload-slot-store')
          await releaseWorkloadSlot(slot.runId, {
            reason: 'workspace_lease_unavailable',
            skipQueueAdvance: true
          }).catch(() => {})
          const reverted = await updateJobRowForSnapshot(jobId, {
            status: 'pending',
            lastError: null
          })
          if (reverted) {
            emitJobEvent(jobId, { event: 'job_snapshot', data: { job: reverted } })
          }
          return
        }
      }

      const { registerRunRuntime } = await import('./runtime-supervisor')
      const { buildCursorJobRuntimeHandle } = await import('./runtime-handle-cursor')
      const { updateRunRuntimeRef } = await import('./workload-slot-store')
      registerRunRuntime(slot.runId, buildCursorJobRuntimeHandle(jobId))
      await updateRunRuntimeRef(slot.runId, { kind: 'cursor-acp', scopeId: jobId })

      const { preflightSandbox, isOuterSandboxEnabled } = await import('../sandbox')
      const { isTestFakeAgentModeActive } =
        await import('../agent-runtime/providers/test-overrides')
      if (!isTestFakeAgentModeActive()) {
        if (!isOuterSandboxEnabled()) {
          throw createTurnError('sandbox.required', {
            detail: 'Task execution requires the OS outer sandbox with Agent SDK'
          })
        }
        preflightSandbox()
      }
      await runWithExecutionRunContext({ runId: slot.runId, signal: slot.signal }, () =>
        runExecutionLoop(username, jobId)
      )
    } catch (error) {
      // FIX-PLAN F3-C (§8.4): if we are draining for shutdown, an aborted turn is an interruption,
      // not a failure. Keep the Job auto-recoverable `running` and let the finally release the run.
      if (isDraining()) {
        try {
          const { markRunningAttemptsInterruptedForJob } = await import('./task-attempts')
          markRunningAttemptsInterruptedForJob(jobId)
        } catch (interruptError) {
          void interruptError
        }
        return
      }
      executionOutcome = 'failure'
      const turnError = normalizeTurnError(error)
      const existing = await getUserJob(username, jobId)
      if (isExecutionInfraNotReadyError(error)) {
        const reverted = await revertJobAfterInfraStartupFailure(jobId, existing)
        if (reverted) {
          emitJobProgressAfterPersist(jobId, 'snapshot', {
            taskProgress: reverted.taskProgress,
            job: reverted
          })
        }
        return
      }
      const taskProgress = existing
        ? syncTaskProgressForJobFailure(existing.taskProgress, error)
        : undefined
      const failurePatch = {
        status: 'failed' as const,
        lastError: turnError,
        ...(taskProgress ? { taskProgress } : {})
      }
      const job = executionRunId
        ? await updateJobRowForSnapshotFenced(jobId, executionRunId, failurePatch)
        : await updateJobRowForSnapshot(jobId, failurePatch)
      if (job) {
        emitJobError(jobId, turnError)
        emitJobProgressAfterPersist(jobId, 'terminal', {
          taskProgress: job.taskProgress,
          job
        })
      }
      throw error
    } finally {
      if (executionRunId) {
        const { finishExecutionRunLifecycle } = await import('./run-lifecycle')
        await finishExecutionRunLifecycle(executionRunId, {
          username,
          jobId,
          reason: executionOutcome === 'failure' ? 'execution_failed' : 'execution_done',
          outcome: executionOutcome
        })
      } else {
        await finalizeJobExecution({ username, jobId })
        await markJobExecutionDone(jobId, username)
      }
    }
  })().catch(() => {})
}
