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

export interface TaskLaunchDraftAbility {
  abilityCode: string
  label?: string
  description?: string
  reason?: string
  recommendedCoreCode?: string
}

export interface TaskLaunchDraftReference {
  id: string
  name: string
  mimeType: string
  kind: 'image' | 'file' | 'directory'
  assetUrl: string
  description?: string | undefined
  source?: 'upload' | 'import' | 'message' | 'local_corpus' | undefined
  localPath?: string | undefined
}

export interface TaskLaunchDraftPayload {
  draftId?: string
  title?: string
  summary?: string
  userFlow?: string
  techStack?: string
  status?: 'editing' | 'confirmed' | 'archived' | 'pending' | 'launched' | string
  linkedPlanId?: string | null
  designSessionId?: string | null
  lockedSections?: Record<string, boolean>
  requirementsContract?: {
    markdown?: string
    status?: string
    confirmedAt?: string | null
  }
  abilities?: TaskLaunchDraftAbility[]
  references?: TaskLaunchDraftReference[]
  sourceAttachments?: Array<{
    id: string
    name: string
    mimeType: string
    kind: 'image' | 'file'
    assetUrl: string
  }>
  revision?: number
}

export interface AbilitySelection {
  abilityCode: string
  coreCode: string
}

const CORE_LABELS: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  cursorcli: 'Cursor CLI'
}

export function coreLabel(code: string, cores: ConversationCore[]): string {
  return cores.find((core) => core.code === code)?.label ?? CORE_LABELS[code] ?? code
}

export function buildAbilitySelections(
  payload: TaskLaunchDraftPayload | null | undefined
): AbilitySelection[] {
  if (!payload?.abilities?.length) return []
  return payload.abilities.map((ability) => ({
    abilityCode: ability.abilityCode,
    coreCode: ability.recommendedCoreCode || 'codex'
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
