import {
  MAX_DRAFT_ABILITIES,
  MAX_DRAFT_BYTES,
  MAX_DRAFT_REFERENCES,
  type CreateDraftBody,
  type DraftAbility,
  type DraftReference,
  type DraftSnapshot,
  type ExecutionProfile,
  type PatchDraftBody
} from '@codetask/contracts'
import { normalizeProviderCode } from '@codetask/provider-spec'
import {
  assertCanConfirm,
  assertCanStartPlanning,
  assertEditable,
  toDraftSnapshot,
  type DraftRecord
} from '../domain/draft.ts'
import type { DraftAssetPort, DraftRepository, ProjectWorkspacePort } from './ports.ts'
import {
  DesignConflictError,
  DesignForbiddenError,
  DesignNotFoundError,
  DesignValidationError,
  newId,
  nowMs,
  type Actor
} from '../../shared.ts'

function assertDraftWithinLimits(draft: DraftRecord): void {
  if (draft.abilities.length > MAX_DRAFT_ABILITIES) {
    throw new DesignValidationError(`Draft exceeds ${MAX_DRAFT_ABILITIES} abilities`)
  }
  if (draft.references.length > MAX_DRAFT_REFERENCES) {
    throw new DesignValidationError(`Draft exceeds ${MAX_DRAFT_REFERENCES} references`)
  }
  const bytes = new TextEncoder().encode(JSON.stringify(draft)).byteLength
  if (bytes > MAX_DRAFT_BYTES) {
    throw new DesignValidationError(`Draft exceeds ${MAX_DRAFT_BYTES} bytes`)
  }
}

export class DraftApplication {
  constructor(
    private readonly drafts: DraftRepository,
    private readonly projects: ProjectWorkspacePort,
    private readonly assets?: DraftAssetPort
  ) {}

  async list(
    actor: Actor,
    query: { q?: string; completion?: 'all' | 'incomplete' | 'complete' }
  ): Promise<DraftRecord[]> {
    return this.drafts.list({ actorId: actor.userId, ...query })
  }

  async get(actor: Actor, draftId: string): Promise<DraftRecord> {
    return this.requireOwned(actor, draftId)
  }

  async create(actor: Actor, body: CreateDraftBody): Promise<DraftRecord> {
    const workspaceRoot = await this.projects.resolveWorkspaceRoot({
      actorId: actor.userId,
      projectId: body.projectId
    })
    const now = nowMs()
    const draft: DraftRecord = {
      id: newId('draft'),
      actorId: actor.userId,
      projectId: body.projectId,
      title: body.title.trim(),
      summary: body.summary?.trim() ?? '',
      userFlow: body.userFlow?.trim() ?? '',
      techStack: body.techStack?.trim() ?? '',
      nfr: body.nfr ?? [],
      acceptance: body.acceptance ?? [],
      verification: body.verification ?? [],
      outOfScope: body.outOfScope ?? [],
      assumptions: body.assumptions ?? [],
      requirementsMarkdown: body.requirementsMarkdown?.trim() ?? '',
      requirementsStatus: 'pending',
      lockedSections: {},
      executionProfile: null,
      workspaceRoot,
      status: 'editing',
      lockRevision: 0,
      createdAt: now,
      updatedAt: now,
      abilities: [],
      references: []
    }
    assertDraftWithinLimits(draft)
    await this.drafts.insert(draft)
    return draft
  }

  async patch(actor: Actor, draftId: string, body: PatchDraftBody): Promise<DraftRecord> {
    const current = await this.requireOwned(actor, draftId)
    assertEditable(current)
    if (current.lockRevision !== body.expectedRevision) {
      throw new DesignConflictError()
    }
    const next: DraftRecord = {
      ...current,
      title: body.title?.trim() ?? current.title,
      summary: body.summary?.trim() ?? current.summary,
      userFlow: body.userFlow?.trim() ?? current.userFlow,
      techStack: body.techStack?.trim() ?? current.techStack,
      nfr: body.nfr ?? current.nfr,
      acceptance: body.acceptance ?? current.acceptance,
      verification: body.verification ?? current.verification,
      outOfScope: body.outOfScope ?? current.outOfScope,
      assumptions: body.assumptions ?? current.assumptions,
      requirementsMarkdown: body.requirementsMarkdown?.trim() ?? current.requirementsMarkdown,
      lockRevision: current.lockRevision + 1,
      updatedAt: nowMs()
    }
    assertDraftWithinLimits(next)
    return this.drafts.update(next, body.expectedRevision)
  }

  async confirm(actor: Actor, draftId: string, expectedRevision: number): Promise<DraftRecord> {
    const current = await this.requireOwned(actor, draftId)
    if (current.lockRevision !== expectedRevision) throw new DesignConflictError()
    assertCanConfirm(current)
    const next: DraftRecord = {
      ...current,
      status: 'confirmed',
      requirementsStatus: 'confirmed',
      lockedSections: {
        ...current.lockedSections,
        requirementsContract: true,
        abilities: true,
        references: true
      },
      lockRevision: current.lockRevision + 1,
      updatedAt: nowMs()
    }
    return this.drafts.update(next, expectedRevision)
  }

  async unlock(actor: Actor, draftId: string, expectedRevision: number): Promise<DraftRecord> {
    const current = await this.requireOwned(actor, draftId)
    if (current.lockRevision !== expectedRevision) throw new DesignConflictError()
    if (current.status === 'archived') {
      throw new DesignValidationError('Archived draft cannot be unlocked')
    }
    const active = await this.drafts.countActivePlanningSessions(draftId)
    if (active > 0) {
      throw new DesignValidationError(
        'Cancel or retain active planning sessions before unlocking draft'
      )
    }
    const next: DraftRecord = {
      ...current,
      status: 'editing',
      requirementsStatus: 'pending',
      lockedSections: {},
      lockRevision: current.lockRevision + 1,
      updatedAt: nowMs()
    }
    return this.drafts.update(next, expectedRevision)
  }

  async confirmSection(
    actor: Actor,
    draftId: string,
    section: string,
    expectedRevision: number
  ): Promise<DraftRecord> {
    const current = await this.requireOwned(actor, draftId)
    assertEditable(current)
    if (current.lockRevision !== expectedRevision) throw new DesignConflictError()
    const next: DraftRecord = {
      ...current,
      lockedSections: { ...current.lockedSections, [section]: true },
      lockRevision: current.lockRevision + 1,
      updatedAt: nowMs()
    }
    return this.drafts.update(next, expectedRevision)
  }

  async patchAbilities(
    actor: Actor,
    draftId: string,
    expectedRevision: number,
    abilities: DraftAbility[]
  ): Promise<DraftRecord> {
    const current = await this.requireOwned(actor, draftId)
    assertEditable(current)
    if (current.lockRevision !== expectedRevision) throw new DesignConflictError()
    const normalizedAbilities = abilities.map((ability) => {
      const provider = normalizeProviderCode(ability.recommendedCoreCode)
      if (!provider) {
        throw new DesignValidationError(
          `Unsupported ability provider ${ability.recommendedCoreCode}`
        )
      }
      return { ...ability, recommendedCoreCode: provider }
    })
    const next: DraftRecord = {
      ...current,
      abilities: normalizedAbilities,
      lockRevision: current.lockRevision + 1,
      updatedAt: nowMs()
    }
    assertDraftWithinLimits(next)
    return this.drafts.updateAbilities(next, expectedRevision, normalizedAbilities)
  }

  async patchExecutionProfile(
    actor: Actor,
    draftId: string,
    expectedRevision: number,
    executionProfile: ExecutionProfile
  ): Promise<DraftRecord> {
    const current = await this.requireOwned(actor, draftId)
    assertEditable(current)
    if (current.lockRevision !== expectedRevision) throw new DesignConflictError()
    const plannerCoreCode = normalizeProviderCode(executionProfile.plannerCoreCode)
    const sliceVerifierCoreCode = normalizeProviderCode(executionProfile.sliceVerifierCoreCode)
    const milestoneVerifierCoreCode = normalizeProviderCode(
      executionProfile.milestoneVerifierCoreCode
    )
    if (!plannerCoreCode || !sliceVerifierCoreCode || !milestoneVerifierCoreCode) {
      throw new DesignValidationError('Execution profile contains an unsupported provider')
    }
    const normalizedProfile: ExecutionProfile = {
      plannerCoreCode,
      sliceVerifierCoreCode,
      milestoneVerifierCoreCode
    }
    const next: DraftRecord = {
      ...current,
      executionProfile: normalizedProfile,
      lockRevision: current.lockRevision + 1,
      updatedAt: nowMs()
    }
    return this.drafts.update(next, expectedRevision)
  }

  async listReferences(actor: Actor, draftId: string): Promise<DraftReference[]> {
    const draft = await this.requireOwned(actor, draftId)
    return draft.references
  }

  async addReference(
    actor: Actor,
    draftId: string,
    reference: Omit<DraftReference, 'id'> & { id?: string },
    expectedRevision: number
  ): Promise<DraftRecord> {
    const current = await this.requireOwned(actor, draftId)
    assertEditable(current)
    if (current.lockRevision !== expectedRevision) throw new DesignConflictError()
    if (!reference.description.trim()) {
      throw new DesignValidationError('Reference description is required')
    }
    const candidate: DraftReference = {
      ...reference,
      id: reference.id ?? newId('ref'),
      description: reference.description.trim()
    }
    const nextRef =
      this.assets?.prepareReference({
        actorId: actor.userId,
        projectId: current.projectId,
        draftId,
        reference: candidate
      }) ?? candidate
    const references = [...current.references, nextRef]
    const next: DraftRecord = {
      ...current,
      references,
      lockRevision: current.lockRevision + 1,
      updatedAt: nowMs()
    }
    assertDraftWithinLimits(next)
    this.assets?.retainReference(draftId, nextRef)
    try {
      const updated = await this.drafts.updateReferences(next, expectedRevision, references)
      this.assets?.commitReference?.(draftId, nextRef)
      return updated
    } catch (error) {
      this.assets?.releaseReference(draftId, nextRef)
      throw error
    }
  }

  async patchReference(
    actor: Actor,
    draftId: string,
    referenceId: string,
    patch: { name?: string; description?: string },
    expectedRevision: number
  ): Promise<DraftRecord> {
    const current = await this.requireOwned(actor, draftId)
    assertEditable(current)
    if (current.lockRevision !== expectedRevision) throw new DesignConflictError()
    const references = current.references.map((ref) =>
      ref.id === referenceId
        ? {
            ...ref,
            name: patch.name?.trim() ?? ref.name,
            description: patch.description?.trim() ?? ref.description
          }
        : ref
    )
    if (!references.some((r) => r.id === referenceId)) {
      throw new DesignNotFoundError('Reference not found')
    }
    const next: DraftRecord = {
      ...current,
      references,
      lockRevision: current.lockRevision + 1,
      updatedAt: nowMs()
    }
    assertDraftWithinLimits(next)
    return this.drafts.updateReferences(next, expectedRevision, references)
  }

  async deleteReference(
    actor: Actor,
    draftId: string,
    referenceId: string,
    expectedRevision: number
  ): Promise<DraftRecord> {
    const current = await this.requireOwned(actor, draftId)
    assertEditable(current)
    if (current.lockRevision !== expectedRevision) throw new DesignConflictError()
    const removed = current.references.find((reference) => reference.id === referenceId)
    if (!removed) throw new DesignNotFoundError('Reference not found')
    const references = current.references.filter((r) => r.id !== referenceId)
    const next: DraftRecord = {
      ...current,
      references,
      lockRevision: current.lockRevision + 1,
      updatedAt: nowMs()
    }
    assertDraftWithinLimits(next)
    const updated = await this.drafts.updateReferences(next, expectedRevision, references)
    this.assets?.releaseReference(draftId, removed)
    return updated
  }

  async archive(actor: Actor, draftId: string): Promise<void> {
    const current = await this.requireOwned(actor, draftId)
    const activePlanning = await this.drafts.countActivePlanningSessions(draftId)
    if (activePlanning > 0) {
      throw new DesignValidationError('Cancel active planning sessions before deleting the draft')
    }
    const next: DraftRecord = {
      ...current,
      references: [],
      status: 'archived',
      lockRevision: current.lockRevision + 1,
      updatedAt: nowMs()
    }
    await this.drafts.updateReferences(next, current.lockRevision, [])
    this.assets?.releaseDraft(draftId)
  }

  async captureConfirmedSnapshot(actor: Actor, draftId: string): Promise<DraftSnapshot> {
    const draft = await this.requireOwned(actor, draftId)
    assertCanStartPlanning(draft)
    return toDraftSnapshot(draft)
  }

  private async requireOwned(actor: Actor, draftId: string): Promise<DraftRecord> {
    const draft = await this.drafts.getById(draftId)
    if (!draft) throw new DesignNotFoundError('Draft not found')
    if (draft.actorId !== actor.userId) throw new DesignForbiddenError()
    return draft
  }
}
