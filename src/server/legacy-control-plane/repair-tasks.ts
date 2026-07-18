import type { FlatTaskPlan, PlannerRegisteredTask, SavedJobPlan } from '../planner/plan-types'
import type { MilestoneVerificationVerdict, SliceVerificationVerdict } from './verification/types'
import { MAX_SM_REPAIR_GENERATIONS } from './recovery-limits'

export const DEFAULT_MAX_REPAIR_TASKS_PER_VERDICT = 3
export const MAX_REPAIR_GENERATIONS = MAX_SM_REPAIR_GENERATIONS

export interface RepairInjectionResult {
  created: number
  requested: number
  capped: boolean
  newTaskIds: string[]
}

function parseSliceCoords(sliceId: string): { m: number; s: number } | null {
  const match = /^m(\d+)-s(\d+)$/i.exec(sliceId.trim())
  if (!match) return null
  return { m: Number(match[1]), s: Number(match[2]) }
}

function sliceTasks(
  plan: SavedJobPlan,
  milestoneIndex: number,
  sliceIndex: number
): FlatTaskPlan[] {
  return plan.tasks
    .filter((t) => t.milestoneIndex === milestoneIndex && t.sliceIndex === sliceIndex)
    .sort((a, b) => a.taskIndex - b.taskIndex)
}

function nextTaskIndex(plan: SavedJobPlan, milestoneIndex: number, sliceIndex: number): number {
  const tasks = sliceTasks(plan, milestoneIndex, sliceIndex)
  return tasks.length > 0 ? Math.max(...tasks.map((t) => t.taskIndex)) + 1 : 1
}

function formatEvidenceTrace(
  trace: Array<{ requirement: string; status: string; evidence?: string[] | undefined }>
): string {
  if (trace.length === 0) return '- (no evidence trace entries)'
  return trace
    .map((item) => {
      const evidence = item.evidence?.length ? item.evidence.join('; ') : 'no evidence'
      return `- ${item.requirement}: ${item.status} (${evidence})`
    })
    .join('\n')
}

function buildSliceRepairContext(
  sliceTitle: string,
  sliceDescription: string,
  verdict: SliceVerificationVerdict,
  reason: string,
  instruction: string,
  generation: number
): string {
  return [
    '## Slice Evidence Repair Task',
    '',
    `Slice: ${sliceTitle}`,
    `Slice description: ${sliceDescription.trim() || '(none)'}`,
    '',
    'This is an evidence-gap repair, not a test-script failure.',
    'The slice verifier did not run shell commands.',
    '',
    `Repair generation: ${generation}/${MAX_REPAIR_GENERATIONS}.`,
    `Evidence gap: ${reason}`,
    `Required repair: ${instruction}`,
    `Verifier summary: ${verdict.summary}`,
    '',
    '## Current evidence trace',
    formatEvidenceTrace(verdict.evidenceTrace),
    '',
    '## Rules',
    'Use relative paths only.',
    'Do not add validation scripts to satisfy the verifier.',
    'Submit a fresh task result through report_task_result with summary, changedFiles, evidence, and validation.'
  ].join('\n')
}

function buildMilestoneRepairContext(
  milestoneTitle: string,
  sliceTitle: string,
  targetContext: string,
  verdict: MilestoneVerificationVerdict,
  evidenceGap: string,
  instruction: string,
  generation: number
): string {
  const traceLines =
    verdict.requirementTrace.length > 0
      ? verdict.requirementTrace
          .map((item) => {
            const evidence = item.evidence?.length ? item.evidence.join('; ') : 'no evidence'
            return `- ${item.requirement}: ${item.status} (${evidence})`
          })
          .join('\n')
      : '- (no requirement trace entries)'

  return [
    '## Milestone Evidence Repair Task',
    '',
    `Milestone: ${milestoneTitle}`,
    `Slice: ${sliceTitle}`,
    '',
    `Repair generation: ${generation}/${MAX_REPAIR_GENERATIONS}.`,
    `Evidence gap: ${evidenceGap}`,
    `Required repair: ${instruction}`,
    `Verifier summary: ${verdict.summary}`,
    '',
    '## Requirement trace',
    traceLines,
    '',
    '## Rules',
    'Use relative paths only.',
    'Submit a fresh task result through report_task_result.',
    targetContext ? `\n## Target Task Context\n${targetContext}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function appendRepairTask(
  plan: SavedJobPlan,
  input: {
    milestoneIndex: number
    sliceIndex: number
    taskIndex: number
    title: string
    description: string
    contextMarkdown: string
    template: FlatTaskPlan
    parentTaskId: string

    dependsOnParent?: boolean
  }
): string {
  const id = `m${input.milestoneIndex}-s${input.sliceIndex}-t${input.taskIndex}`
  const dependsOnTaskRefs = input.dependsOnParent === false ? [] : [input.parentTaskId]
  const flat: FlatTaskPlan = {
    id,
    milestoneIndex: input.milestoneIndex,
    sliceIndex: input.sliceIndex,
    taskIndex: input.taskIndex,
    title: input.title,
    description: input.description,
    taskKind: input.template.taskKind,
    abilityCode: input.template.abilityCode,
    contextMarkdown: input.contextMarkdown,
    successCriteria: input.template.successCriteria,
    dependsOnTaskRefs,
    canRunInParallel: false
  }
  plan.tasks.push(flat)

  const milestone = plan.milestones[input.milestoneIndex - 1]
  const slice = milestone?.slices[input.sliceIndex - 1]
  if (milestone && slice) {
    const nested: PlannerRegisteredTask = {
      title: flat.title,
      description: flat.description,
      taskKind: flat.taskKind,
      abilityCode: flat.abilityCode,
      dependsOnTaskRefs: [...dependsOnTaskRefs],
      canRunInParallel: false
    }
    slice.tasks.push(nested)
  }

  return id
}

export function injectSliceRepairTasks(input: {
  plan: SavedJobPlan
  sliceId: string
  verdict: SliceVerificationVerdict
  generation: number
  maxTasksPerVerdict?: number
}): RepairInjectionResult {
  const coords = parseSliceCoords(input.sliceId)
  if (!coords) {
    throw new Error(`invalid slice id ${input.sliceId}`)
  }

  const tasks = sliceTasks(input.plan, coords.m, coords.s)
  if (tasks.length === 0) {
    throw new Error(`slice ${input.sliceId} has no tasks to use as repair template`)
  }
  const tasksById = new Map(tasks.map((t) => [t.id, t]))
  const templateDefault = tasks[tasks.length - 1]!

  const milestone = input.plan.milestones[coords.m - 1]
  const slicePlan = milestone?.slices[coords.s - 1]
  const sliceTitle = slicePlan?.title ?? input.sliceId
  const sliceDescription = slicePlan?.description ?? ''

  const maxTasks = Math.max(1, input.maxTasksPerVerdict ?? DEFAULT_MAX_REPAIR_TASKS_PER_VERDICT)
  const requested = input.verdict.repairSuggestions.length
  const newTaskIds: string[] = []
  let created = 0
  let nextIndex = nextTaskIndex(input.plan, coords.m, coords.s)

  for (const suggestion of input.verdict.repairSuggestions.slice(0, maxTasks)) {
    const template =
      suggestion.targetTaskId && tasksById.has(suggestion.targetTaskId)
        ? tasksById.get(suggestion.targetTaskId)!
        : templateDefault
    const title = `[REPAIR] ${suggestion.reason.slice(0, 80)}`
    const context = buildSliceRepairContext(
      sliceTitle,
      sliceDescription,
      input.verdict,
      suggestion.reason,
      suggestion.instruction,
      input.generation
    )
    const id = appendRepairTask(input.plan, {
      milestoneIndex: coords.m,
      sliceIndex: coords.s,
      taskIndex: nextIndex,
      title,
      description: suggestion.instruction,
      contextMarkdown: context,
      template,
      parentTaskId: template.id
    })
    newTaskIds.push(id)
    created += 1
    nextIndex += 1
  }

  return {
    created,
    requested,
    capped: requested > maxTasks,
    newTaskIds
  }
}

export function injectMilestoneRepairTasks(input: {
  plan: SavedJobPlan
  milestoneId: string
  verdict: MilestoneVerificationVerdict
  generation: number
  maxTasksPerVerdict?: number
}): RepairInjectionResult {
  const match = /^m(\d+)$/i.exec(input.milestoneId.trim())
  if (!match) throw new Error(`invalid milestone id ${input.milestoneId}`)
  const milestoneIndex = Number(match[1])
  const milestonePlan = input.plan.milestones[milestoneIndex - 1]
  if (!milestonePlan) throw new Error(`milestone ${input.milestoneId} not found`)

  const milestoneTasks = input.plan.tasks.filter((t) => t.milestoneIndex === milestoneIndex)
  const tasksById = new Map(milestoneTasks.map((t) => [t.id, t]))
  const sliceByTask = new Map(milestoneTasks.map((t) => [t.id, t.sliceIndex]))

  const maxTasks = Math.max(1, input.maxTasksPerVerdict ?? DEFAULT_MAX_REPAIR_TASKS_PER_VERDICT)
  const requested = input.verdict.repairTasks.length
  const newTaskIds: string[] = []
  let created = 0

  for (const repair of input.verdict.repairTasks.slice(0, maxTasks)) {
    let sliceIndex: number | null = null
    if (repair.targetSliceId) {
      const coords = parseSliceCoords(repair.targetSliceId)
      if (!coords || coords.m !== milestoneIndex) {
        throw new Error(
          `repair targetSliceId ${repair.targetSliceId} is outside ${input.milestoneId}`
        )
      }
      sliceIndex = coords.s
    } else if (repair.targetTaskId) {
      sliceIndex = sliceByTask.get(repair.targetTaskId) ?? null
    }
    if (!sliceIndex) {
      throw new Error('repairTasks must target a slice or task explicitly')
    }

    const sliceId = `m${milestoneIndex}-s${sliceIndex}`
    const sliceTasksInSlice = sliceTasks(input.plan, milestoneIndex, sliceIndex)
    const template =
      (repair.targetTaskId ? tasksById.get(repair.targetTaskId) : undefined) ??
      sliceTasksInSlice[sliceTasksInSlice.length - 1]
    if (!template) {
      throw new Error(`slice ${sliceId} has no tasks for milestone repair`)
    }

    const slicePlan = milestonePlan.slices[sliceIndex - 1]
    const title = `[REPAIR] Milestone evidence: ${slicePlan?.title ?? sliceId}`
    const context = buildMilestoneRepairContext(
      milestonePlan.title ?? input.milestoneId,
      slicePlan?.title ?? sliceId,
      repair.targetTaskId ? (tasksById.get(repair.targetTaskId)?.contextMarkdown ?? '') : '',
      input.verdict,
      repair.evidenceGap,
      repair.instruction,
      input.generation
    )
    const taskIndex = nextTaskIndex(input.plan, milestoneIndex, sliceIndex)
    const id = appendRepairTask(input.plan, {
      milestoneIndex,
      sliceIndex,
      taskIndex,
      title,
      description: `Repair required by milestone verifier: ${repair.instruction}`,
      contextMarkdown: context,
      template,
      parentTaskId: template.id
    })
    newTaskIds.push(id)
    created += 1
  }

  return {
    created,
    requested,
    capped: requested > maxTasks,
    newTaskIds
  }
}

export function repairGenerationKey(scope: 'slice' | 'milestone', id: string): string {
  return `${scope}:${id}`
}

export function taskInfraRetryGenerationKey(taskId: string): string {
  return `task-infra:${taskId}`
}

export function taskPrepGenerationKey(taskId: string): string {
  return `task-prep:${taskId}`
}

export function taskRepairGenerationKey(taskId: string): string {
  return `task-repair:${taskId}`
}

export function verifierInfraRetryGenerationKey(scope: 'slice' | 'milestone', id: string): string {
  return `verifier-infra:${scope}:${id}`
}

function addDependsOnTaskRef(plan: SavedJobPlan, taskId: string, dependencyId: string): void {
  const flat = plan.tasks.find((task) => task.id === taskId)
  if (!flat) throw new Error(`task ${taskId} not found for dependency update`)
  const next = new Set([...(flat.dependsOnTaskRefs ?? []), dependencyId])
  flat.dependsOnTaskRefs = [...next]

  const milestone = plan.milestones[flat.milestoneIndex - 1]
  const slice = milestone?.slices[flat.sliceIndex - 1]
  const nested = slice?.tasks[flat.taskIndex - 1]
  if (nested) {
    nested.dependsOnTaskRefs = flat.dependsOnTaskRefs
  }
}

function buildTaskDependencyPrepContext(input: {
  blockedTaskId: string
  blockedTitle: string
  summary: string
  blockers: string[]
  generation: number
}): string {
  return [
    '## Task Dependency Preparation',
    '',
    `Blocked task: ${input.blockedTaskId} — ${input.blockedTitle}`,
    `Preparation generation: ${input.generation}/${MAX_REPAIR_GENERATIONS}.`,
    '',
    'The blocked task reported missing workspace prerequisites. Resolve them here so the blocked task can run again.',
    '',
    `Summary: ${input.summary}`,
    'Blockers:',
    ...input.blockers.map((item) => `  - ${item}`),
    '',
    '## Rules',
    '- Create or restore only what the blockers require (files, modules, i18n keys, stubs).',
    '- Use workspace-relative paths only.',
    '- Do not mark the original task complete here.',
    '- Submit a fresh report_task_result with status completed when prerequisites are in place.',
    '- Use blockerKind=dependency-prep only if you still cannot finish preparation.'
  ].join('\n')
}

export function injectTaskDependencyPrepTask(input: {
  plan: SavedJobPlan
  blockedTaskId: string
  summary: string
  blockers: string[]
  generation: number
}): RepairInjectionResult {
  const match = /^m(\d+)-s(\d+)-t(\d+)$/i.exec(input.blockedTaskId.trim())
  if (!match) throw new Error(`invalid task id ${input.blockedTaskId}`)

  const milestoneIndex = Number(match[1])
  const sliceIndex = Number(match[2])
  const blocked = input.plan.tasks.find((task) => task.id === input.blockedTaskId)
  if (!blocked) throw new Error(`task ${input.blockedTaskId} not found`)

  const taskIndex = nextTaskIndex(input.plan, milestoneIndex, sliceIndex)
  const primaryBlocker = input.blockers[0] ?? input.summary
  const title = `[PREP] ${primaryBlocker.slice(0, 72)}`
  const context = buildTaskDependencyPrepContext({
    blockedTaskId: input.blockedTaskId,
    blockedTitle: blocked.title,
    summary: input.summary,
    blockers: input.blockers,
    generation: input.generation
  })

  const prepId = appendRepairTask(input.plan, {
    milestoneIndex,
    sliceIndex,
    taskIndex,
    title,
    description: `Prepare prerequisites for ${input.blockedTaskId}: ${primaryBlocker}`,
    contextMarkdown: context,
    template: blocked,
    parentTaskId: input.blockedTaskId,
    dependsOnParent: false
  })

  addDependsOnTaskRef(input.plan, input.blockedTaskId, prepId)

  return {
    created: 1,
    requested: 1,
    capped: false,
    newTaskIds: [prepId]
  }
}

function buildTaskImplementationRepairContext(input: {
  blockedTaskId: string
  blockedTitle: string
  summary: string
  blockers: string[]
  generation: number
}): string {
  return [
    '## Task Implementation Repair',
    '',
    `Blocked task: ${input.blockedTaskId} — ${input.blockedTitle}`,
    `Repair generation: ${input.generation}/${MAX_REPAIR_GENERATIONS}.`,
    '',
    'The original task reported implementation or validation failure. Fix the incomplete work, regressions, or failing checks so the blocked task can succeed on its next run.',
    '',
    `Summary: ${input.summary}`,
    'Issues:',
    ...input.blockers.map((item) => `  - ${item}`),
    '',
    '## Rules',
    '- Fix only what the blocked task broke or left incomplete.',
    '- Use workspace-relative paths only.',
    '- Do not mark the original task complete here.',
    '- Submit report_task_result with status completed when the repair is done.',
    '- Use blockerKind=implementation only if the issue cannot be fixed in-workspace.'
  ].join('\n')
}

export function injectTaskImplementationRepairTask(input: {
  plan: SavedJobPlan
  blockedTaskId: string
  summary: string
  blockers: string[]
  generation: number
}): RepairInjectionResult {
  const match = /^m(\d+)-s(\d+)-t(\d+)$/i.exec(input.blockedTaskId.trim())
  if (!match) throw new Error(`invalid task id ${input.blockedTaskId}`)

  const milestoneIndex = Number(match[1])
  const sliceIndex = Number(match[2])
  const blocked = input.plan.tasks.find((task) => task.id === input.blockedTaskId)
  if (!blocked) throw new Error(`task ${input.blockedTaskId} not found`)

  const taskIndex = nextTaskIndex(input.plan, milestoneIndex, sliceIndex)
  const primaryIssue = input.blockers[0] ?? input.summary
  const title = `[REPAIR] ${primaryIssue.slice(0, 72)}`
  const context = buildTaskImplementationRepairContext({
    blockedTaskId: input.blockedTaskId,
    blockedTitle: blocked.title,
    summary: input.summary,
    blockers: input.blockers,
    generation: input.generation
  })

  const repairId = appendRepairTask(input.plan, {
    milestoneIndex,
    sliceIndex,
    taskIndex,
    title,
    description: `Repair implementation issues for ${input.blockedTaskId}: ${primaryIssue}`,
    contextMarkdown: context,
    template: blocked,
    parentTaskId: input.blockedTaskId,
    dependsOnParent: false
  })

  addDependsOnTaskRef(input.plan, input.blockedTaskId, repairId)

  return {
    created: 1,
    requested: 1,
    capped: false,
    newTaskIds: [repairId]
  }
}

function buildEvidenceResubmitContext(input: {
  scopeLabel: string
  targetLabel: string
  reason: string
  attempt: number
  maxAttempts: number
}): string {
  return [
    '## Evidence Resubmit Repair Task',
    '',
    `Scope: ${input.scopeLabel}`,
    `Target: ${input.targetLabel}`,
    `Verification attempt: ${input.attempt}/${input.maxAttempts}`,
    `Reason: ${input.reason}`,
    '',
    'Re-run the work if needed, then call report_task_result with a fresh evidence bundle:',
    '- summary, changedFiles (workspace-relative only), evidence, validation',
    '- blockers when status is blocked',
    '',
    'Do not submit absolute paths or .. segments in changedFiles.'
  ].join('\n')
}

export function injectSliceEvidenceRepairTask(input: {
  plan: SavedJobPlan
  sliceId: string
  reason: string
  attempt: number
  maxAttempts: number
}): RepairInjectionResult {
  const coords = parseSliceCoords(input.sliceId)
  if (!coords) throw new Error(`invalid slice id ${input.sliceId}`)

  const tasks = sliceTasks(input.plan, coords.m, coords.s)
  if (tasks.length === 0) {
    throw new Error(`slice ${input.sliceId} has no tasks for evidence repair`)
  }
  const template = tasks[tasks.length - 1]!
  const milestone = input.plan.milestones[coords.m - 1]
  const slicePlan = milestone?.slices[coords.s - 1]
  const sliceTitle = slicePlan?.title ?? input.sliceId
  const taskIndex = nextTaskIndex(input.plan, coords.m, coords.s)
  const context = buildEvidenceResubmitContext({
    scopeLabel: 'slice',
    targetLabel: sliceTitle,
    reason: input.reason,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts
  })
  const id = appendRepairTask(input.plan, {
    milestoneIndex: coords.m,
    sliceIndex: coords.s,
    taskIndex,
    title: `[EVIDENCE] Resubmit slice evidence`,
    description: input.reason,
    contextMarkdown: context,
    template,
    parentTaskId: template.id
  })

  return { created: 1, requested: 1, capped: false, newTaskIds: [id] }
}

export function injectMilestoneEvidenceRepairTask(input: {
  plan: SavedJobPlan
  milestoneId: string
  reason: string
  attempt: number
  maxAttempts: number
}): RepairInjectionResult {
  const match = /^m(\d+)$/i.exec(input.milestoneId.trim())
  if (!match) throw new Error(`invalid milestone id ${input.milestoneId}`)
  const milestoneIndex = Number(match[1])
  const milestonePlan = input.plan.milestones[milestoneIndex - 1]
  if (!milestonePlan) throw new Error(`milestone ${input.milestoneId} not found`)

  const milestoneTasks = input.plan.tasks.filter((t) => t.milestoneIndex === milestoneIndex)
  const template = milestoneTasks[milestoneTasks.length - 1]
  if (!template) throw new Error(`milestone ${input.milestoneId} has no tasks for evidence repair`)

  const sliceIndex = template.sliceIndex
  const context = buildEvidenceResubmitContext({
    scopeLabel: 'milestone',
    targetLabel: milestonePlan.title ?? input.milestoneId,
    reason: input.reason,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts
  })
  const taskIndex = nextTaskIndex(input.plan, milestoneIndex, sliceIndex)
  const id = appendRepairTask(input.plan, {
    milestoneIndex,
    sliceIndex,
    taskIndex,
    title: `[EVIDENCE] Resubmit milestone evidence`,
    description: input.reason,
    contextMarkdown: context,
    template,
    parentTaskId: template.id
  })

  return { created: 1, requested: 1, capped: false, newTaskIds: [id] }
}
