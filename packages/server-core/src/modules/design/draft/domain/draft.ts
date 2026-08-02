import type {
  DraftAbility,
  DraftReference,
  DraftSnapshot,
  DraftStatus,
  ExecutionProfile
} from '@codetask/contracts'
import { DesignValidationError } from '../../shared.ts'

export type DraftRecord = {
  id: string
  actorId: string
  projectId: string
  title: string
  summary: string
  userFlow: string
  techStack: string
  nfr: string[]
  acceptance: Array<{ id: string; given: string; when: string; then: string }>
  verification: Array<{ command: string; appliesTo: string }>
  outOfScope: string[]
  assumptions: string[]
  requirementsMarkdown: string
  requirementsStatus: 'pending' | 'confirmed'
  lockedSections: Record<string, boolean>
  executionProfile: ExecutionProfile | null
  workspaceRoot: string
  status: DraftStatus
  lockRevision: number
  createdAt: number
  updatedAt: number
  abilities: DraftAbility[]
  references: DraftReference[]
}

export function assertEditable(draft: DraftRecord): void {
  if (draft.status !== 'editing') {
    throw new DesignValidationError('Draft is not editable')
  }
}

export function assertCanConfirm(draft: DraftRecord): void {
  assertEditable(draft)
  if (!draft.requirementsMarkdown.trim()) {
    throw new DesignValidationError('Requirements contract is required')
  }
  if (draft.abilities.length === 0) {
    throw new DesignValidationError('At least one ability is required')
  }
  if (!draft.executionProfile) {
    throw new DesignValidationError('Execution profile is required')
  }
  for (const ref of draft.references) {
    if (!ref.description.trim()) {
      throw new DesignValidationError(`Reference ${ref.id} requires a description`)
    }
  }
}

export function assertCanStartPlanning(draft: DraftRecord): void {
  if (draft.status !== 'confirmed') {
    throw new DesignValidationError('Draft must be confirmed before planning')
  }
  if (draft.requirementsStatus !== 'confirmed') {
    throw new DesignValidationError('Requirements contract must be confirmed')
  }
  if (!draft.executionProfile) {
    throw new DesignValidationError('Execution profile is required')
  }
  if (draft.abilities.length === 0) {
    throw new DesignValidationError('At least one ability is required')
  }
}

export function toDraftSnapshot(draft: DraftRecord): DraftSnapshot {
  return {
    draftId: draft.id,
    actorId: draft.actorId,
    projectId: draft.projectId,
    title: draft.title,
    summary: draft.summary,
    userFlow: draft.userFlow,
    techStack: draft.techStack,
    nfr: draft.nfr,
    acceptance: draft.acceptance,
    verification: draft.verification,
    outOfScope: draft.outOfScope,
    assumptions: draft.assumptions,
    requirementsMarkdown: draft.requirementsMarkdown,
    requirementsStatus: draft.requirementsStatus,
    lockedSections: draft.lockedSections,
    workspaceRoot: draft.workspaceRoot,
    status: draft.status,
    lockRevision: draft.lockRevision,
    abilities: draft.abilities,
    references: draft.references,
    executionProfile: draft.executionProfile ?? undefined,
    capturedAt: new Date().toISOString()
  }
}
