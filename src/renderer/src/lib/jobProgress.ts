import type { ThreadJobDto } from '@shared/contracts/jobs'
import {
  buildUnifiedProgressTree,
  type UnifiedMilestoneNode,
  type UnifiedSliceNode,
  type UnifiedTaskNode
} from '@shared/plan-tree'
import { resolveJobLifecycleBucket, type JobLifecycleBucket } from '@shared/job-lifecycle'
import {
  formatExecutionQueueLabel,
  isExecutionDisplayStatus,
  resolveJobStatusBadgeClass,
  resolveJobStatusBadgeKey,
  resolveJobStatusDisplay
} from '@shared/job-display'
import { formatUnixTimestamp } from '@renderer/lib/formatDateTime'
import { resolvePlanningPercent } from '@shared/plan-generation-progress'

export { resolveJobLifecycleBucket, type JobLifecycleBucket }

export type {
  UnifiedMilestoneNode,
  UnifiedSliceNode,
  UnifiedTaskNode,
  UnifiedTaskNode as PlanTreeTaskNode
}

export type PlanTreeSelection =
  | { kind: 'milestone'; node: UnifiedMilestoneNode }
  | { kind: 'slice'; node: UnifiedSliceNode }
  | { kind: 'task'; node: UnifiedTaskNode }

export type TranslateFn = (key: string, params?: Record<string, unknown>) => string

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key]
    return value === undefined ? `{${key}}` : String(value)
  })
}

function formatProgressCode(
  code: string | null | undefined,
  t: TranslateFn,
  params?: Record<string, unknown> | null
): string | null {
  if (!code) return null
  const key = `workspace.tasks.progress.code.${code}`
  const translated = t(key, params ?? {})
  if (translated === key) return null
  return interpolate(translated, params ?? undefined)
}

export interface JobProgressSnapshot {
  kind: 'plan' | 'execution' | 'idle'
  status: string
  percent: number
  stepsDone: number
  stepsTotal: number
  summaryLabel: string
  tone: 'active' | 'success' | 'danger'
}

const CORE_LABELS: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  cursorcli: 'Cursor CLI'
}

export function coreLabel(code: string): string {
  return CORE_LABELS[code] ?? code
}

export function resolveAbilityCli(
  abilityCode: string,
  abilities: Array<{ abilityCode: string; recommendedCoreCode?: string }> = []
): string {
  const match = abilities.find((item) => item.abilityCode === abilityCode)
  if (match?.recommendedCoreCode) return coreLabel(match.recommendedCoreCode)
  return abilityCode
}

export function resolveTaskCli(
  task: Pick<UnifiedTaskNode, 'abilityCode' | 'coreCode'>,
  abilities: Array<{ abilityCode: string; recommendedCoreCode?: string }> = []
): string {
  if (task.coreCode?.trim()) return coreLabel(task.coreCode.trim())
  return resolveAbilityCli(task.abilityCode, abilities)
}

export function jobCliSummary(job: Pick<ThreadJobDto, 'abilities'>): string {
  const codes = Array.from(
    new Set(
      (job.abilities ?? []).map((item) => item.recommendedCoreCode?.trim() ?? '').filter(Boolean)
    )
  )
  return codes.length ? codes.map(coreLabel).join(' / ') : '-'
}

function isExecutionPhase(status: string): boolean {
  return ['pending', 'running', 'pausing', 'paused', 'completed', 'failed'].includes(status)
}

function resolvePendingExecutionSummary(
  job: ThreadJobDto,
  t: TranslateFn,
  fallback?: string | null
): string {
  return formatExecutionQueueLabel(t, job.queue) ?? fallback ?? t('workspace.tasks.status.pending')
}

export function getPlanProgressSnapshot(
  job: ThreadJobDto | null | undefined,
  t: TranslateFn
): JobProgressSnapshot {
  const status = job?.status ?? ''
  const plan = job?.planProgress

  if (!job || !plan) {
    return {
      kind: 'idle',
      status,
      percent: 0,
      stepsDone: 0,
      stepsTotal: 0,
      summaryLabel: '',
      tone: 'active'
    }
  }

  if (status === 'pending' || plan.status === 'pending') {
    return {
      kind: 'plan',
      status,
      percent: 0,
      stepsDone: 0,
      stepsTotal: 0,
      summaryLabel: resolvePendingExecutionSummary(
        job,
        t,
        formatProgressCode(plan.progressCode, t, plan.progressParams ?? undefined) ??
          plan.message ??
          null
      ),
      tone: 'active'
    }
  }

  if (
    status === 'failed' &&
    (plan.phase === 'failed' || plan.phase === 'cleanup_failed' || plan.phase === 'needs_auth')
  ) {
    const total = plan.contextsTotal || plan.tasks || 0
    const done = plan.contextsRegistered
    return {
      kind: 'plan',
      status,
      percent: total > 0 ? resolvePlanningPercent(done, total) : 8,
      stepsDone: done,
      stepsTotal: total,
      summaryLabel:
        formatProgressCode(plan.progressCode, t, plan.progressParams ?? undefined) ??
        plan.message ??
        (plan.phase === 'needs_auth'
          ? t('workspace.tasks.progress.needsAuth')
          : plan.phase === 'cleanup_failed'
            ? t('workspace.tasks.progress.cleanupFailed')
            : t('workspace.tasks.progress.planningFailed')),
      tone: 'danger'
    }
  }

  if (status === 'planning' || plan.phase === 'planning') {
    const done = plan.contextsRegistered
    const total = plan.contextsTotal
    const allStepsRegistered = total > 0 && done >= total
    const percent = resolvePlanningPercent(done, total)
    return {
      kind: 'plan',
      status,
      percent,
      stepsDone: done,
      stepsTotal: total > 0 ? total : done,
      summaryLabel:
        formatProgressCode(plan.progressCode, t, plan.progressParams ?? undefined) ??
        (allStepsRegistered
          ? plan.message || t('workspace.tasks.progress.planFinalizing')
          : total > 0
            ? done > 0
              ? t('workspace.tasks.progress.planning', { done, total })
              : t('workspace.tasks.progress.planOutlineReady', { total })
            : plan.message || t('workspace.tasks.progress.planningRunning')),
      tone: 'active'
    }
  }

  if (plan.phase === 'plan_ready' || status === 'plan_ready') {
    const total = plan.tasks ?? plan.contextsTotal ?? 0
    return {
      kind: 'plan',
      status,
      percent: 100,
      stepsDone: total,
      stepsTotal: total,
      summaryLabel:
        formatProgressCode(plan.progressCode, t, plan.progressParams ?? undefined) ??
        plan.message ??
        (total > 0
          ? t('workspace.tasks.progress.planStepsDone', { done: total, total })
          : t('workspace.tasks.progress.planReady')),
      tone: 'success'
    }
  }

  return {
    kind: 'idle',
    status,
    percent: 0,
    stepsDone: 0,
    stepsTotal: 0,
    summaryLabel: '',
    tone: 'active'
  }
}

export function getExecutionProgressSnapshot(
  job: ThreadJobDto | null | undefined,
  t: TranslateFn
): JobProgressSnapshot {
  const status = job?.status ?? ''
  const progress = job?.taskProgress

  if (!job || !progress || !isExecutionPhase(status)) {
    return {
      kind: 'idle',
      status,
      percent: 0,
      stepsDone: 0,
      stepsTotal: 0,
      summaryLabel: '',
      tone: 'active'
    }
  }

  const total = progress.total || progress.tasks.length
  const done = progress.tasks.filter(
    (item) => item.status === 'completed' || item.status === 'skipped'
  ).length

  if (status === 'pending') {
    return {
      kind: 'execution',
      status,
      percent: 0,
      stepsDone: done,
      stepsTotal: total,
      summaryLabel: resolvePendingExecutionSummary(job, t),
      tone: 'active'
    }
  }

  if (status === 'completed' || progress.phase === 'completed') {
    return {
      kind: 'execution',
      status,
      percent: 100,
      stepsDone: done,
      stepsTotal: total,
      summaryLabel: t('workspace.tasks.progress.executionDone', { done, total }),
      tone: 'success'
    }
  }

  if (status === 'failed' || progress.phase === 'failed') {
    return {
      kind: 'execution',
      status,
      percent: total > 0 ? Math.round((done / total) * 100) : 0,
      stepsDone: done,
      stepsTotal: total,
      summaryLabel:
        formatProgressCode(progress.progressCode, t, progress.progressParams ?? undefined) ??
        progress.message ??
        t('workspace.tasks.progress.executionFailed'),
      tone: 'danger'
    }
  }

  if (status === 'paused' || status === 'pausing') {
    return {
      kind: 'execution',
      status,
      percent: total > 0 ? Math.round((done / total) * 100) : 0,
      stepsDone: done,
      stepsTotal: total,
      summaryLabel:
        formatProgressCode(progress.progressCode, t, progress.progressParams ?? undefined) ??
        progress.message ??
        t('workspace.tasks.progress.executionPaused', { done, total }),
      tone: 'active'
    }
  }

  const activeBonus = progress.currentTaskId ? 0.35 : 0
  const percent =
    total > 0
      ? Math.min(99, Math.round(((done + activeBonus) / total) * 100))
      : status === 'running'
        ? 12
        : 0

  return {
    kind: 'execution',
    status,
    percent,
    stepsDone: done,
    stepsTotal: total,
    summaryLabel:
      formatProgressCode(progress.progressCode, t, progress.progressParams ?? undefined) ??
      progress.message ??
      (total > 0
        ? t('workspace.tasks.progress.executionRunning', { done, total })
        : t('workspace.tasks.progress.executionStarting')),
    tone: 'active'
  }
}

export function getJobProgressSnapshot(
  job: ThreadJobDto | null | undefined,
  t: TranslateFn
): JobProgressSnapshot {
  const execution = getExecutionProgressSnapshot(job, t)
  if (execution.kind === 'execution' && execution.stepsTotal > 0) return execution
  const plan = getPlanProgressSnapshot(job, t)
  if (
    plan.kind === 'plan' &&
    (plan.stepsTotal > 0 || job?.status === 'planning' || job?.status === 'pending')
  )
    return plan
  return plan.kind !== 'idle' ? plan : execution
}

export function jobStatusLabel(status: string, t: TranslateFn, job?: ThreadJobDto | null): string {
  if (isExecutionDisplayStatus(status)) {
    const queueLabel = job ? formatExecutionQueueLabel(t, job.queue) : null
    if (queueLabel && status === 'pending') return queueLabel
    return t(resolveJobStatusBadgeKey(status))
  }
  const key = `workspace.tasks.status.${status}` as const
  const translated = t(key)
  return translated === key ? status : translated
}

export function jobStatusClass(status: string): string {
  if (isExecutionDisplayStatus(status)) {
    return resolveJobStatusBadgeClass(status)
  }
  switch (status) {
    case 'plan_editing':
    case 'plan_ready':
    case 'plan_confirmed':
    case 'completed':
      return 'bg-emerald-50 text-emerald-700'
    case 'planning':
    case 'running':
      return 'bg-sky-50 text-sky-700'
    case 'paused':
      return 'bg-zinc-100 text-zinc-700'
    case 'failed':
      return 'bg-red-50 text-red-700'
    case 'cancelled':
      return 'bg-zinc-100 text-zinc-700'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

export function formatJobTimestamp(sec: number): string {
  return formatUnixTimestamp(sec)
}

export function formatMilestoneTitle(title: string, order: number, t: TranslateFn): string {
  const trimmed = title.trim()
  if (!trimmed) return t('workspace.tasks.tree.milestoneFallback', { n: order })
  return trimmed
}

export function formatSliceTitle(title: string, order: number, t: TranslateFn): string {
  const trimmed = title.trim()
  if (!trimmed) return t('workspace.tasks.tree.sliceFallback', { n: order })
  return trimmed
}

export function buildPlanTree(
  job: ThreadJobDto | null | undefined,
  _t: TranslateFn
): UnifiedMilestoneNode[] {
  if (!job) return []
  void _t
  const tree = buildUnifiedProgressTree({
    jobId: job.id,
    title: job.title,
    jobStatus: job.status,
    plan: job.plan as Parameters<typeof buildUnifiedProgressTree>[0]['plan'],
    taskProgressItems: job.taskProgress?.tasks,
    currentTaskId: job.taskProgress?.currentTaskId ?? null,
    verification: {
      slices: job.taskProgress?.slices,
      milestones: job.taskProgress?.milestones
    },
    abilities: job.abilities,
    referenceManifest: job.referenceManifest
  })
  return tree.milestones
}

export function taskVisualStatus(task: UnifiedTaskNode, jobStatus: string): string {
  if (jobStatus === 'planning') return task.planStatus
  const status = task.executionStatus ?? task.status
  if (status === 'completed') return 'completed'
  if (status === 'running' || status === 'ready') return 'in_progress'
  if (status === 'waiting-on-dependency' || status === 'queued') return 'pending'
  if (status === 'failed' || status === 'blocked') return 'failed'
  if (
    status === 'retry-queued' ||
    status === 'waiting-on-dependency' ||
    status === 'waiting-on-repair'
  ) {
    return 'in_progress'
  }
  return task.status || task.planStatus
}

export function nodeIcon(status: string, active = false): string {
  if (active) return '▶'
  switch (status) {
    case 'completed':
    case 'planned':
      return '✓'
    case 'in_progress':
      return '◉'
    case 'failed':
      return '✕'
    case 'pending':
    case 'queued':
      return '○'
    default:
      return '·'
  }
}

export function statusBadgeLabel(
  status: string,
  t: TranslateFn,
  phase: 'plan' | 'execution'
): string {
  if (phase === 'plan') {
    switch (status) {
      case 'planned':
        return t('workspace.tasks.tree.planned')
      case 'queued':
        return t('workspace.tasks.tree.queued')
      default:
        return t('workspace.tasks.tree.pending')
    }
  }
  const key = `workspace.tasks.tree.exec.${status}` as const
  const translated = t(key)
  return translated === key ? status : translated
}

export function jobLifecycleBadgeClass(bucket: JobLifecycleBucket): string {
  switch (bucket) {
    case 'completed':
      return 'bg-emerald-50 text-emerald-700'
    case 'failed':
      return 'bg-red-50 text-red-700'
    case 'cancelled':
      return 'bg-zinc-100 text-zinc-700'
    default:
      return 'bg-amber-50 text-amber-700'
  }
}

export function jobLifecycleLabel(bucket: JobLifecycleBucket, t: TranslateFn): string {
  switch (bucket) {
    case 'completed':
      return t('workspace.tasks.lifecycle.completed')
    case 'failed':
      return t('workspace.tasks.lifecycle.failed')
    case 'cancelled':
      return t('workspace.tasks.lifecycle.cancelled')
    default:
      return t('workspace.tasks.lifecycle.inProgress')
  }
}

const LIFECYCLE_ONLY_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/** One list-row badge: prefer fine-grained status while running; lifecycle for terminal states. */
export function resolveJobListStatusBadge(
  status: string,
  t: TranslateFn,
  job?: ThreadJobDto | null
): { label: string; className: string } {
  if (LIFECYCLE_ONLY_STATUSES.has(status)) {
    const bucket = resolveJobLifecycleBucket(status)
    return {
      label: jobLifecycleLabel(bucket, t),
      className: jobLifecycleBadgeClass(bucket)
    }
  }
  if (isExecutionDisplayStatus(status)) {
    const display = resolveJobStatusDisplay(status)
    const queueLabel = status === 'pending' ? formatExecutionQueueLabel(t, job?.queue) : null
    return {
      label: queueLabel ?? t(display.badge),
      className: resolveJobStatusBadgeClass(status)
    }
  }
  return {
    label: jobStatusLabel(status, t, job),
    className: jobStatusClass(status)
  }
}
