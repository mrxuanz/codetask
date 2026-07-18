import type { SupportedCoreCode } from '../cores'
import { PRODUCTION_LANDING_QUALITY_BAR } from '../prompts'
import {
  TASK_LAUNCH_ABILITY_CATALOG,
  THREAD_WORKSPACE_FIELD_KEYS,
  type ProposedTaskDraft,
  type TaskLaunchDraftAbility,
  type TaskLaunchDraftPayload,
  type TaskLaunchDraftRequirementsContract
} from './types'

function normalizeCoreCode(value: unknown): SupportedCoreCode | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (
    (['codex', 'claude-code', 'opencode', 'cursorcli'] as const).includes(
      trimmed as SupportedCoreCode
    )
  ) {
    return trimmed as SupportedCoreCode
  }
  if (trimmed === 'claude' || trimmed === 'claudecode') return 'claude-code'
  if (trimmed === 'cursor-cli' || trimmed === 'cursor-agent') return 'cursorcli'
  return null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeAbilities(value: unknown): TaskLaunchDraftAbility[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const abilities: TaskLaunchDraftAbility[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const object = item as Record<string, unknown>
    const abilityCode = nonEmptyString(object.abilityCode)
    const reason = nonEmptyString(object.reason)
    if (!abilityCode || !reason || seen.has(abilityCode)) continue
    const catalog = TASK_LAUNCH_ABILITY_CATALOG.find((entry) => entry.code === abilityCode)
    if (!catalog) continue
    seen.add(abilityCode)
    abilities.push({
      abilityCode: catalog.code,
      label: catalog.label,
      description: catalog.description,
      reason,
      recommendedCoreCode: normalizeCoreCode(object.recommendedCoreCode) ?? 'codex'
    })
  }
  return abilities
}

const DEFAULT_PLANNING_ABILITY_CODES = [
  'project-setup',
  'dependency-management',
  'scaffolding',
  'backend-implementation',
  'frontend-implementation',
  'data-modeling',
  'testing-validation',
  'documentation-handoff',
  'general-implementation'
] as const

export function ensureDraftPlanningAbilities(
  payload: TaskLaunchDraftPayload,
  coreCode: SupportedCoreCode
): TaskLaunchDraftPayload {
  if (payload.abilities.length > 0) return payload

  const abilities: TaskLaunchDraftAbility[] = DEFAULT_PLANNING_ABILITY_CODES.map((code) => {
    const catalog = TASK_LAUNCH_ABILITY_CATALOG.find((entry) => entry.code === code)
    return {
      abilityCode: code,
      label: catalog?.label ?? 'General Implementation',
      description: catalog?.description ?? 'General implementation work for this task.',
      reason: catalog
        ? `Auto-inferred for planning (${catalog.label}).`
        : 'Auto-inferred fallback ability for tasks without a specific workstream.',
      recommendedCoreCode: coreCode
    }
  })

  return { ...payload, abilities }
}

export function sanitizeProposeTaskDraftArguments(
  argumentsValue: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...argumentsValue }
  for (const key of THREAD_WORKSPACE_FIELD_KEYS) {
    delete next[key]
  }
  delete next.collection
  const selection = next.confirmedSelection
  if (selection && typeof selection === 'object') {
    const copy = { ...(selection as Record<string, unknown>) }
    for (const key of THREAD_WORKSPACE_FIELD_KEYS) {
      delete copy[key]
    }
    next.confirmedSelection = copy
  }
  return next
}

export function normalizeProposedTaskDraft(value: unknown): ProposedTaskDraft | null {
  if (!value || typeof value !== 'object') return null
  const sanitized = sanitizeProposeTaskDraftArguments(value as Record<string, unknown>)
  const title = nonEmptyString(sanitized.title)
  const summary = nonEmptyString(sanitized.summary)
  if (!title || !summary) return null

  const userFlow = nonEmptyString(sanitized.userFlow) ?? ''
  const techStack = nonEmptyString(sanitized.techStack) ?? ''
  const abilities = normalizeAbilities(sanitized.abilities)
  if (abilities.length === 0) return null

  const acceptance = Array.isArray(sanitized.acceptance)
    ? sanitized.acceptance
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          id: nonEmptyString(item.id) ?? '',
          given: nonEmptyString(item.given) ?? '',
          when: nonEmptyString(item.when) ?? '',
          then: nonEmptyString(item.then) ?? ''
        }))
        .filter((item) => item.id && item.given && item.when && item.then)
    : []

  const verification = Array.isArray(sanitized.verification)
    ? sanitized.verification
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          command: nonEmptyString(item.command) ?? '',
          appliesTo: nonEmptyString(item.appliesTo) ?? ''
        }))
        .filter((item) => item.command && ['all', 'task', 'slice'].includes(item.appliesTo))
    : []

  return {
    title,
    summary,
    userFlow,
    techStack,
    nfr: stringList(sanitized.nfr),
    acceptance,
    verification,
    outOfScope: stringList(sanitized.outOfScope),
    assumptions: stringList(sanitized.assumptions),
    abilities
  }
}

export function buildDraftRequirementsContract(input: {
  title: string
  summary: string
  userFlow: string
  techStack: string
  abilities: TaskLaunchDraftAbility[]
}): string {
  const lines: string[] = [
    '# REQUIREMENTS CONTRACT',
    '',
    '## Goal',
    '',
    `Task: ${input.title}`,
    '',
    input.summary,
    ''
  ]

  if (input.userFlow.trim()) {
    lines.push('## User Flow', '', input.userFlow, '')
  }

  if (input.techStack.trim()) {
    lines.push('## Technical Stack', '', input.techStack, '')
  }

  if (input.abilities.length > 0) {
    lines.push('## Workstreams', '')
    for (const ability of input.abilities) {
      lines.push(`- ${ability.label} (${ability.abilityCode}): ${ability.reason}`)
    }
    lines.push('')
  }

  lines.push(
    '## Quality and task sizing',
    '',
    `- Quality bar: ${PRODUCTION_LANDING_QUALITY_BAR}`,
    '- Downstream planner should produce small tasks (~10 minutes each). Multiple milestones, slices, and tasks are fine.',
    '',
    '## Confirmation Gate',
    '',
    '- This contract must be confirmed before final task launch.',
    '- Any out-of-scope change requires explicit re-confirmation.'
  )

  return lines.join('\n')
}

export function syncRequirementsContractFromDraft(
  payload: TaskLaunchDraftPayload,
  options?: { force?: boolean }
): TaskLaunchDraftPayload {
  if (payload.requirementsContract.status === 'confirmed') {
    return payload
  }
  const markdown = buildDraftRequirementsContract({
    title: payload.title,
    summary: payload.summary,
    userFlow: payload.userFlow,
    techStack: payload.techStack,
    abilities: payload.abilities
  })
  if (!options?.force && markdown.trim() === payload.requirementsContract.markdown.trim()) {
    return payload
  }
  return {
    ...payload,
    requirementsContract: {
      ...payload.requirementsContract,
      markdown,
      status: 'pending',
      confirmedAt: null
    }
  }
}

export function bindPayloadWorkspace(
  payload: TaskLaunchDraftPayload,
  workspacePath: string
): TaskLaunchDraftPayload {
  return {
    ...payload,
    workspacePath: workspacePath.trim()
  }
}

export function draftPayloadToClientJson(payload: TaskLaunchDraftPayload): Record<string, unknown> {
  const { workspacePath: _workspacePath, ...rest } = payload
  return rest
}

export function createTaskLaunchDraftPayload(input: {
  draftId: string
  sourceMessageId: string
  proposed: ProposedTaskDraft
  workspacePath: string
  sourceAttachments?: import('../types').MessageAttachment[]
}): TaskLaunchDraftPayload {
  const requirementsMarkdown = buildDraftRequirementsContract({
    title: input.proposed.title,
    summary: input.proposed.summary,
    userFlow: input.proposed.userFlow,
    techStack: input.proposed.techStack,
    abilities: input.proposed.abilities
  })

  const requirementsContract: TaskLaunchDraftRequirementsContract = {
    markdown: requirementsMarkdown,
    status: 'pending',
    confirmedAt: null
  }

  const sourceAttachments = input.sourceAttachments ?? []
  const references = sourceAttachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    kind: attachment.kind,
    assetUrl: attachment.assetUrl,
    description: '',
    source: 'message' as const
  }))

  return bindPayloadWorkspace(
    {
      draftId: input.draftId,
      sourceMessageId: input.sourceMessageId,
      title: input.proposed.title,
      summary: input.proposed.summary,
      userFlow: input.proposed.userFlow,
      techStack: input.proposed.techStack,
      nfr: input.proposed.nfr,
      acceptance: input.proposed.acceptance,
      verification: input.proposed.verification,
      outOfScope: input.proposed.outOfScope,
      assumptions: input.proposed.assumptions,
      requirementsContract,
      workspacePath: '',
      status: 'editing',
      linkedPlanId: null,
      lockedSections: {},
      abilities: input.proposed.abilities,
      references,
      sourceAttachments,
      revision: 1
    },
    input.workspacePath
  )
}

export function confirmRequirementsContract(
  payload: TaskLaunchDraftPayload,
  confirmedAt: string
): TaskLaunchDraftPayload {
  return {
    ...payload,
    requirementsContract: {
      ...payload.requirementsContract,
      status: 'confirmed',
      confirmedAt
    }
  }
}

export function buildUnlockedDraftPayload(payload: TaskLaunchDraftPayload): TaskLaunchDraftPayload {
  return {
    ...payload,
    status: 'editing',
    linkedPlanId: null,
    lockedSections: {},
    requirementsContract: {
      ...payload.requirementsContract,
      status: 'pending',
      confirmedAt: null
    }
  }
}

export function buildUnlockedRequirementsContractPayload(
  payload: TaskLaunchDraftPayload
): TaskLaunchDraftPayload {
  const { requirementsContract: _locked, ...restLockedSections } = payload.lockedSections ?? {}
  return {
    ...payload,
    lockedSections: restLockedSections,
    requirementsContract: {
      ...payload.requirementsContract,
      status: 'pending',
      confirmedAt: null
    }
  }
}
