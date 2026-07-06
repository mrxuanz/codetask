import type { SliceVerificationRecordDto } from '@shared/contracts/evidence'
import type { SavedJobPlan } from '../../planner/plan-types'
import type { GateMilestoneState, GateSliceState } from '../execution-gate'
import type { TaskProgressItemDto } from '../types'
import { buildWorkspaceSnapshot } from '../../conversation/workspace-snapshot'
import { formatTaskEvidenceForPrompt } from './normalize'
import { readWorkspaceRelativeFileExcerpt } from './paths'

const MAX_EXCERPT_CHARS = 2_400
const MAX_CHANGED_FILE_EXCERPTS = 12

function collectChangedFileExcerpts(
  workspaceRoot: string,
  taskItems: TaskProgressItemDto[]
): string {
  const paths = new Set<string>()
  for (const item of taskItems) {
    for (const path of item.evidence?.changedFiles ?? []) {
      if (path.trim()) paths.add(path.trim())
    }
  }

  const lines: string[] = []
  let count = 0
  for (const path of paths) {
    if (count >= MAX_CHANGED_FILE_EXCERPTS) {
      lines.push('…(additional changed files omitted)')
      break
    }
    const excerpt = readWorkspaceRelativeFileExcerpt(workspaceRoot, path, MAX_EXCERPT_CHARS)
    if (!excerpt) {
      lines.push(`### ${path}\n(file missing, unreadable, or outside workspace)`)
    } else {
      lines.push(`### ${path}\n\`\`\`\n${excerpt}\n\`\`\``)
    }
    count += 1
  }

  if (lines.length === 0) {
    return '(no changed file excerpts available)'
  }
  return lines.join('\n\n')
}

function formatSliceVerdictRecord(record: SliceVerificationRecordDto | null | undefined): string {
  if (!record) return '(no slice verdict recorded)'
  const trace =
    record.evidenceTrace.length > 0
      ? record.evidenceTrace
          .map((item) => {
            const evidence = item.evidence?.length ? item.evidence.join('; ') : 'no evidence'
            return `- ${item.requirement}: ${item.status} (${evidence})`
          })
          .join('\n')
      : '- (empty evidence trace)'
  return [
    `status: ${record.status}`,
    `confidence: ${record.confidence}`,
    `summary: ${record.summary}`,
    'evidenceTrace:',
    trace
  ].join('\n')
}

function findSliceInPlan(
  plan: SavedJobPlan,
  sliceId: string
): {
  title: string
  successCriteria: string
  taskIds: string[]
} | null {
  const match = /^m(\d+)-s(\d+)$/.exec(sliceId)
  if (!match) return null
  const mIdx = Number(match[1]) - 1
  const sIdx = Number(match[2]) - 1
  const milestone = plan.milestones[mIdx]
  const slice = milestone?.slices[sIdx]
  if (!milestone || !slice) return null
  const taskIds = plan.tasks
    .filter((t) => t.milestoneIndex === mIdx + 1 && t.sliceIndex === sIdx + 1)
    .map((t) => t.id)
  return {
    title: slice.title ?? sliceId,
    successCriteria: slice.successCriteria ?? '',
    taskIds
  }
}

export function buildSliceVerifierEvidenceBundle(input: {
  workspacePath: string
  plan: SavedJobPlan
  sliceId: string
  taskItems: TaskProgressItemDto[]
}): string {
  const slice = findSliceInPlan(input.plan, input.sliceId)
  const sliceTasks = slice
    ? input.taskItems.filter((item) => slice.taskIds.includes(item.id))
    : input.taskItems

  const taskEvidenceSections = sliceTasks.map((item) => {
    const evidence = item.evidence
    return [
      `### ${item.id}: ${item.title}`,
      `execution: ${item.executionStatus ?? '-'}`,
      `evidenceStatus: ${item.evidenceStatus ?? '-'}`,
      evidence ? formatTaskEvidenceForPrompt(evidence) : '(no structured evidence submitted)'
    ].join('\n')
  })

  const sections = [
    '# Evidence Bundle (slice verification)',
    '',
    '## Workspace snapshot',
    buildWorkspaceSnapshot(input.workspacePath),
    '',
    '## Changed file excerpts (from task evidence)',
    collectChangedFileExcerpts(input.workspacePath, sliceTasks),
    '',
    '## Task evidence packets',
    taskEvidenceSections.length > 0 ? taskEvidenceSections.join('\n\n') : '(no tasks)',
    '',
    'Review the evidence bundle against slice success criteria and submit complete_slice_verification.'
  ]

  if (slice) {
    sections.splice(
      2,
      0,
      `## Slice ${input.sliceId}: ${slice.title}`,
      '',
      '## Success Criteria',
      slice.successCriteria.trim() || '(none)',
      ''
    )
  }

  return sections.join('\n')
}

export function buildMilestoneVerifierEvidenceBundle(input: {
  workspacePath: string
  plan: SavedJobPlan
  milestone: GateMilestoneState
  slices: GateSliceState[]
  taskItems: TaskProgressItemDto[]
  sliceVerdicts: Record<string, SliceVerificationRecordDto | undefined>
}): string {
  const mIdx = Number(input.milestone.id.replace(/^m/, '')) - 1
  const milestonePlan = input.plan.milestones[mIdx]
  const milestoneIndex = mIdx + 1

  const milestoneTasks = input.plan.tasks
    .filter((task) => task.milestoneIndex === milestoneIndex)
    .sort((a, b) => {
      if (a.sliceIndex !== b.sliceIndex) return a.sliceIndex - b.sliceIndex
      return a.taskIndex - b.taskIndex
    })

  const sliceSections = input.milestone.sliceIds.map((sliceId) => {
    const slice = input.slices.find((s) => s.id === sliceId)
    const verdict = input.sliceVerdicts[sliceId]
    return [
      `### ${sliceId}`,
      `runtime: ${slice?.runtimeStatus ?? 'pending'}, verification: ${slice?.verificationStatus ?? '-'}`,
      '',
      formatSliceVerdictRecord(verdict)
    ].join('\n')
  })

  const taskSummaries = milestoneTasks.map((task) => {
    const progress = input.taskItems.find((item) => item.id === task.id)
    const evidence = progress?.evidence
    return [
      `### ${task.id}: ${task.title}`,
      `status: ${progress?.status ?? 'unknown'}`,
      evidence ? formatTaskEvidenceForPrompt(evidence) : '(no structured evidence)'
    ].join('\n')
  })

  const taskLines = milestoneTasks.map((task) => `- ${task.id}: ${task.title}`)
  const sliceLines = input.milestone.sliceIds.map((sliceId) => {
    const slice = input.slices.find((s) => s.id === sliceId)
    return `- ${sliceId}: runtime=${slice?.runtimeStatus ?? 'pending'}, verification=${slice?.verificationStatus ?? '-'}`
  })

  return [
    `# Milestone ${input.milestone.id}: ${input.milestone.title}`,
    '',
    '## Success Criteria',
    milestonePlan?.successCriteria?.trim() || milestonePlan?.description || '',
    '',
    '## Workspace snapshot',
    buildWorkspaceSnapshot(input.workspacePath),
    '',
    '## Changed file excerpts (from task evidence)',
    collectChangedFileExcerpts(
      input.workspacePath,
      input.taskItems.filter((item) => milestoneTasks.some((t) => t.id === item.id))
    ),
    '',
    '## Slice verdicts / evidenceTrace',
    sliceSections.join('\n\n'),
    '',
    '## Task evidence summaries',
    taskSummaries.join('\n\n'),
    '',
    '## Allowed targetSliceId values',
    sliceLines.join('\n'),
    '',
    '## Allowed targetTaskId values',
    taskLines.length > 0 ? taskLines.join('\n') : '- (none)',
    '',
    'For needs-repair verdicts, each repairTasks item must use one of the slice IDs or task IDs above.',
    'Review the full evidence bundle and submit complete_milestone_verification when finished.'
  ].join('\n')
}

export function sliceVerdictFromRecord(
  record: SliceVerificationRecordDto | null | undefined
): SliceVerificationRecordDto | undefined {
  return record ?? undefined
}

export function toSliceVerificationRecord(
  verdict: import('../verification/types').SliceVerificationVerdict
): SliceVerificationRecordDto {
  return {
    status: verdict.status,
    confidence: verdict.confidence,
    summary: verdict.summary,
    evidenceTrace: verdict.evidenceTrace,
    satisfiedSignals: verdict.satisfiedSignals,
    missingSignals: verdict.missingSignals
  }
}
