import type { ConversationCore } from '@renderer/api/conversation'
import { formatDateTimeValue } from '@renderer/lib/formatDateTime'
import {
  collectMissingReferenceDescriptions,
  referenceRequiresDescription,
  type DraftReferenceLike
} from '@shared/draft-references'
import {
  isDraftListEntryLaunched,
  isLaunchedJobStatus,
  LAUNCHED_JOB_STATUSES
} from '@shared/job-lifecycle'
import type {
  TaskLaunchDraftAbility,
  TaskLaunchDraftPayload,
  TaskLaunchDraftReference
} from '@codetask/contracts'

export type {
  TaskLaunchDraftAbility,
  TaskLaunchDraftPayload,
  TaskLaunchDraftReference
} from '@codetask/contracts'

export interface AbilitySelection {
  abilityCode: string
  providerCode: string
}

/** Map Design module draft DTO → create-task form payload (not a ConversationMessage). */
export function designDraftToPayload(draft: {
  id: string
  title: string
  summary: string
  userFlow: string
  techStack: string
  requirementsMarkdown: string
  requirementsStatus: string
  workspaceRoot: string
  status: string
  lockedSections: Record<string, boolean>
  abilities?: TaskLaunchDraftAbility[]
  references?: Array<{
    id: string
    name: string
    kind: 'image' | 'file' | 'directory'
    mimeType?: string
    assetUrl?: string
    description?: string
    source?: string
    localPath?: string
  }>
  executionProfile?: TaskLaunchDraftPayload['executionConfig'] | null
  lockRevision: number
  linkedPlanId?: string | null
  designSessionId?: string | null
  launchedJobId?: string | null
}): TaskLaunchDraftPayload {
  return {
    draftId: draft.id,
    title: draft.title,
    summary: draft.summary,
    userFlow: draft.userFlow,
    techStack: draft.techStack,
    requirementsContract: {
      markdown: draft.requirementsMarkdown,
      status: draft.requirementsStatus
    },
    workspacePath: draft.workspaceRoot,
    status: draft.status,
    linkedPlanId: draft.linkedPlanId ?? null,
    designSessionId: draft.designSessionId ?? null,
    launchedJobId: draft.launchedJobId ?? null,
    lockedSections: draft.lockedSections,
    abilities: draft.abilities ?? [],
    references: (draft.references ?? []).map((ref) => ({
      id: ref.id,
      name: ref.name,
      mimeType: ref.mimeType ?? 'application/octet-stream',
      kind: ref.kind,
      assetUrl: ref.assetUrl ?? '',
      description: ref.description,
      source: (ref.source as TaskLaunchDraftReference['source']) ?? undefined,
      localPath: ref.localPath
    })),
    executionConfig: draft.executionProfile ?? undefined,
    revision: draft.lockRevision
  }
}

/** Prefer control-plane / listCores labels; fall back to the raw code (PRU-11-05). */
export function coreLabel(code: string, cores: ConversationCore[]): string {
  return cores.find((core) => core.code === code)?.label ?? code
}

export function buildAbilitySelections(
  payload: TaskLaunchDraftPayload | null | undefined
): AbilitySelection[] {
  if (!payload?.abilities?.length) return []
  return payload.abilities.map((ability) => ({
    abilityCode: ability.abilityCode,
    providerCode: ability.recommendedCoreCode || 'codex'
  }))
}

export function formatDateTime(value?: string | null): string {
  return formatDateTimeValue(value)
}

export { referenceRequiresDescription, collectMissingReferenceDescriptions }

export function mergeDraftReferences(
  payload: TaskLaunchDraftPayload | null | undefined
): TaskLaunchDraftReference[] {
  if (!payload) return []
  const refs = [...(payload.references ?? [])]
  const seen = new Set(refs.map((item) => item.id))
  for (const attachment of payload.sourceAttachments ?? []) {
    if (seen.has(attachment.id)) continue
    seen.add(attachment.id)
    refs.push({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
      assetUrl: attachment.assetUrl,
      description: '',
      source: 'message'
    })
  }
  return refs
}

export function draftReferencesReady(references: DraftReferenceLike[]): boolean {
  return collectMissingReferenceDescriptions(references).length === 0
}

export const DRAFT_WIZARD_STEP_COUNT = 3

export { isLaunchedJobStatus, LAUNCHED_JOB_STATUSES }

export function isDraftLaunched(draft: {
  plan?: { status: string } | null
  linkedPlanId?: string | null
  launched?: boolean
  jobId?: string | null
}): boolean {
  return isDraftListEntryLaunched({
    launched: draft.launched,
    planStatus: draft.plan?.status,
    hasLaunchedJobId: draft.launched === true && Boolean(draft.jobId)
  })
}

export function resolveDraftStep(
  payload: TaskLaunchDraftPayload | null | undefined,
  plan: { status: string } | null | undefined
): number {
  if (!payload?.requirementsContract?.markdown) return 0
  if (payload.status === 'editing' && !payload.linkedPlanId) {
    return 1
  }
  if (
    plan?.status === 'plan_editing' ||
    plan?.status === 'planning' ||
    payload.linkedPlanId ||
    (plan &&
      [
        'pending',
        'running',
        'paused',
        'completed',
        'failed',
        'cancelled',
        'plan_confirmed'
      ].includes(plan.status))
  ) {
    return 2
  }
  return 1
}

export function isDraftStepComplete(
  step: number,
  payload: TaskLaunchDraftPayload | null | undefined,
  plan: { status: string } | null | undefined
): boolean {
  if (step === 0) return Boolean(payload?.requirementsContract?.markdown)
  if (step === 1) {
    return Boolean(payload?.linkedPlanId || plan)
  }
  if (step === 2) {
    return Boolean(
      plan &&
      [
        'pending',
        'running',
        'paused',
        'completed',
        'failed',
        'cancelled',
        'plan_confirmed'
      ].includes(plan.status)
    )
  }
  return false
}
