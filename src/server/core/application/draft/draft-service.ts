import { createHash } from 'node:crypto'
import type {
  Clock,
  DraftAssetStore,
  DraftAttachmentRecord,
  DraftExecutionTreeRecord,
  DraftGenerationRunRecord,
  DraftRecord,
  DraftSettingsRecord,
  IdGenerator,
  JobIntakeAttachmentRecord,
  JobIntakeHandoffRecord,
  UnitOfWork
} from '../ports'
import {
  DEFAULT_DRAFT_PLANNER_PROMPT,
  DEFAULT_DRAFT_SKILLS_MANUAL,
  DraftError,
  type DraftContent,
  type ExecutionTree,
  validateAttachmentName,
  validateDraftContent,
  validateDraftModel,
  validateEditablePlanningText
} from '../../domain/draft'

export const MAX_DRAFT_ATTACHMENT_BYTES = 16 * 1024 * 1024

export interface DraftSettingsView {
  readonly provider: 'cursorcli'
  readonly model: string | null
  readonly plannerPrompt: { readonly value: string; readonly useDefault: boolean }
  readonly skillsManual: { readonly value: string; readonly useDefault: boolean }
  readonly defaults: { readonly plannerPrompt: string; readonly skillsManual: string }
  readonly revision: number
  readonly updatedAtMs: number
}
export interface JobIntakeHandoffView {
  readonly id: string
  readonly sourceDraftId: string
  readonly sourceTreeId: string
  readonly sourceDraftRevision: number
  readonly sourceTreeRevision: number
  readonly state: 'pending' | 'accepted' | 'rejected'
  readonly attachmentCount: number
  readonly createdAtMs: number
  readonly jobModuleImplemented: true
}
export interface DraftDetails {
  readonly draft: DraftRecord
  readonly attachments: readonly DraftAttachmentRecord[]
  readonly executionTree: (DraftExecutionTreeRecord & { readonly tree: ExecutionTree }) | null
  readonly handoff: JobIntakeHandoffView | null
}
export interface BeginDraftGenerationResult {
  readonly draft: DraftRecord
  readonly workspace: { readonly id: string; readonly title: string; readonly rootPath: string }
  readonly attachments: readonly (DraftAttachmentRecord & { readonly absolutePath: string })[]
  readonly run: DraftGenerationRunRecord
  readonly plannerPrompt: string
  readonly skillsManual: string
}

function asTree(record: DraftExecutionTreeRecord | null): DraftDetails['executionTree'] {
  return record ? { ...record, tree: JSON.parse(record.treeJson) as ExecutionTree } : null
}
function settingsView(record: DraftSettingsRecord | null): DraftSettingsView {
  return {
    provider: 'cursorcli',
    model: record?.model ?? null,
    plannerPrompt: {
      value: record?.plannerPrompt ?? DEFAULT_DRAFT_PLANNER_PROMPT,
      useDefault: record?.plannerPrompt == null
    },
    skillsManual: {
      value: record?.skillsManual ?? DEFAULT_DRAFT_SKILLS_MANUAL,
      useDefault: record?.skillsManual == null
    },
    defaults: {
      plannerPrompt: DEFAULT_DRAFT_PLANNER_PROMPT,
      skillsManual: DEFAULT_DRAFT_SKILLS_MANUAL
    },
    revision: record?.revision ?? 0,
    updatedAtMs: record?.updatedAtMs ?? 0
  }
}
function handoffView(
  record: JobIntakeHandoffRecord,
  attachments: readonly JobIntakeAttachmentRecord[]
): JobIntakeHandoffView {
  return {
    id: record.id,
    sourceDraftId: record.sourceDraftId,
    sourceTreeId: record.sourceTreeId,
    sourceDraftRevision: record.sourceDraftRevision,
    sourceTreeRevision: record.sourceTreeRevision,
    state: record.state,
    attachmentCount: attachments.length,
    createdAtMs: record.createdAtMs,
    jobModuleImplemented: true
  }
}

export class DraftService {
  constructor(
    private readonly dependencies: {
      readonly unitOfWork: UnitOfWork
      readonly clock: Clock
      readonly ids: IdGenerator
      readonly assets: DraftAssetStore
    }
  ) {}

  getSettings(userId: string): DraftSettingsView {
    return settingsView(
      this.dependencies.unitOfWork.transaction((tx) => tx.draft.getSettings(userId))
    )
  }

  updateSettings(
    userId: string,
    input: {
      readonly model?: unknown
      readonly plannerPrompt?: unknown
      readonly skillsManual?: unknown
      readonly expectedRevision?: number | undefined
    }
  ): DraftSettingsView {
    const model = validateDraftModel(input.model)
    const plannerPrompt = validateEditablePlanningText(input.plannerPrompt, 'plannerPrompt')
    const skillsManual = validateEditablePlanningText(input.skillsManual, 'skillsManual')
    const record = this.dependencies.unitOfWork.transaction((tx) => {
      const current = tx.draft.getSettings(userId)
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== (current?.revision ?? 0)
      ) {
        throw new DraftError('draft.settings_conflict')
      }
      const next: DraftSettingsRecord = {
        userId,
        provider: 'cursorcli',
        model,
        plannerPrompt,
        skillsManual,
        revision: (current?.revision ?? 0) + 1,
        updatedAtMs: this.dependencies.clock.nowMs()
      }
      tx.draft.putSettings(next)
      return next
    })
    return settingsView(record)
  }

  listDrafts(userId: string, workspaceId?: string): DraftRecord[] {
    return this.dependencies.unitOfWork.transaction((tx) => {
      if (workspaceId && !tx.conversation.getWorkspace(userId, workspaceId)) {
        throw new DraftError('draft.workspace_not_found')
      }
      return tx.draft.listDrafts(userId, workspaceId)
    })
  }

  getDraft(userId: string, draftId: string): DraftDetails {
    return this.dependencies.unitOfWork.transaction((tx) => {
      const draft = tx.draft.getDraft(userId, draftId)
      if (!draft) throw new DraftError('draft.not_found')
      const handoff = tx.jobIntake.getBySourceDraftId(draftId)
      return {
        draft,
        attachments: tx.draft.listAttachments(userId, draftId),
        executionTree: asTree(tx.draft.getActiveExecutionTree(userId, draftId)),
        handoff: handoff ? handoffView(handoff, tx.jobIntake.listAttachments(handoff.id)) : null
      }
    })
  }

  createDraft(
    userId: string,
    input: DraftContent & {
      readonly workspaceId: string
      readonly sourceThreadId?: string | null | undefined
    }
  ): DraftRecord {
    const content = validateDraftContent(input)
    return this.dependencies.unitOfWork.transaction((tx) => {
      if (!tx.conversation.getWorkspace(userId, input.workspaceId)) {
        throw new DraftError('draft.workspace_not_found')
      }
      if (input.sourceThreadId) {
        const thread = tx.conversation.getThread(userId, input.sourceThreadId)
        if (!thread || thread.workspaceId !== input.workspaceId) {
          throw new DraftError('draft.source_thread_invalid')
        }
      }
      const nowMs = this.dependencies.clock.nowMs()
      const record: DraftRecord = {
        id: this.dependencies.ids.generate(),
        userId,
        workspaceId: input.workspaceId,
        sourceThreadId: input.sourceThreadId ?? null,
        ...content,
        status: 'editing',
        revision: 1,
        activeTreeId: null,
        submittedHandoffId: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        submittedAtMs: null
      }
      tx.draft.insertDraft(record)
      return record
    })
  }

  updateDraft(
    userId: string,
    draftId: string,
    input: DraftContent & { readonly expectedRevision: number }
  ): DraftRecord {
    const content = validateDraftContent(input)
    return this.dependencies.unitOfWork.transaction((tx) => {
      const current = tx.draft.getDraft(userId, draftId)
      if (!current) throw new DraftError('draft.not_found')
      if (current.status === 'submitted') throw new DraftError('draft.locked')
      if (tx.draft.getRunningGeneration(draftId)) {
        throw new DraftError('draft.generation_in_progress')
      }
      if (current.revision !== input.expectedRevision) {
        throw new DraftError('draft.revision_conflict')
      }
      const next: DraftRecord = {
        ...current,
        ...content,
        status: 'editing',
        revision: current.revision + 1,
        activeTreeId: null,
        updatedAtMs: this.dependencies.clock.nowMs()
      }
      if (!tx.draft.updateDraftContent(next, current.revision)) {
        throw new DraftError('draft.revision_conflict')
      }
      return next
    })
  }

  async addAttachment(
    userId: string,
    draftId: string,
    input: {
      readonly expectedRevision: number
      readonly displayName: string
      readonly mediaType: string
      readonly bytes: Uint8Array
    }
  ): Promise<{ readonly draft: DraftRecord; readonly attachment: DraftAttachmentRecord }> {
    if (input.bytes.byteLength > MAX_DRAFT_ATTACHMENT_BYTES) {
      throw new DraftError('draft.attachment_too_large', { maxBytes: MAX_DRAFT_ATTACHMENT_BYTES })
    }
    const displayName = validateAttachmentName(input.displayName)
    const attachmentId = this.dependencies.ids.generate()
    const stored = await this.dependencies.assets.storeDraftAttachment({
      draftId,
      attachmentId,
      displayName,
      bytes: input.bytes
    })
    try {
      return this.dependencies.unitOfWork.transaction((tx) => {
        const current = tx.draft.getDraft(userId, draftId)
        if (!current) throw new DraftError('draft.not_found')
        if (current.status === 'submitted') throw new DraftError('draft.locked')
        if (tx.draft.getRunningGeneration(draftId)) {
          throw new DraftError('draft.generation_in_progress')
        }
        if (current.revision !== input.expectedRevision) {
          throw new DraftError('draft.revision_conflict')
        }
        const nowMs = this.dependencies.clock.nowMs()
        const attachment: DraftAttachmentRecord = {
          id: attachmentId,
          draftId,
          displayName,
          mediaType: input.mediaType.trim().slice(0, 200) || 'application/octet-stream',
          sizeBytes: input.bytes.byteLength,
          sha256: createHash('sha256').update(input.bytes).digest('hex'),
          storageRelativePath: stored.storageRelativePath,
          createdAtMs: nowMs
        }
        const next: DraftRecord = {
          ...current,
          status: 'editing',
          revision: current.revision + 1,
          activeTreeId: null,
          updatedAtMs: nowMs
        }
        tx.draft.insertAttachment(attachment)
        if (!tx.draft.updateDraftContent(next, current.revision)) {
          throw new DraftError('draft.revision_conflict')
        }
        return { draft: next, attachment }
      })
    } catch (error) {
      await this.dependencies.assets
        .removeDraftAttachment(stored.storageRelativePath)
        .catch(() => undefined)
      throw error
    }
  }

  async removeAttachment(
    userId: string,
    draftId: string,
    attachmentId: string,
    expectedRevision: number
  ): Promise<DraftRecord> {
    const result = this.dependencies.unitOfWork.transaction((tx) => {
      const current = tx.draft.getDraft(userId, draftId)
      if (!current) throw new DraftError('draft.not_found')
      if (current.status === 'submitted') throw new DraftError('draft.locked')
      if (tx.draft.getRunningGeneration(draftId)) {
        throw new DraftError('draft.generation_in_progress')
      }
      if (current.revision !== expectedRevision) {
        throw new DraftError('draft.revision_conflict')
      }
      const attachment = tx.draft.getAttachment(userId, draftId, attachmentId)
      if (!attachment) throw new DraftError('draft.attachment_not_found')
      const next: DraftRecord = {
        ...current,
        status: 'editing',
        revision: current.revision + 1,
        activeTreeId: null,
        updatedAtMs: this.dependencies.clock.nowMs()
      }
      if (!tx.draft.deleteAttachment(draftId, attachmentId)) {
        throw new DraftError('draft.attachment_not_found')
      }
      if (!tx.draft.updateDraftContent(next, current.revision)) {
        throw new DraftError('draft.revision_conflict')
      }
      return { next, attachment }
    })
    await this.dependencies.assets
      .removeDraftAttachment(result.attachment.storageRelativePath)
      .catch(() => undefined)
    return result.next
  }

  resolveAttachment(
    userId: string,
    draftId: string,
    attachmentId: string
  ): { readonly attachment: DraftAttachmentRecord; readonly absolutePath: string } {
    const attachment = this.dependencies.unitOfWork.transaction((tx) =>
      tx.draft.getAttachment(userId, draftId, attachmentId)
    )
    if (!attachment) throw new DraftError('draft.attachment_not_found')
    return {
      attachment,
      absolutePath: this.dependencies.assets.resolveDraftAttachment(attachment.storageRelativePath)
    }
  }

  async deleteDraft(userId: string, draftId: string): Promise<void> {
    this.dependencies.unitOfWork.transaction((tx) => {
      if (!tx.draft.getDraft(userId, draftId)) throw new DraftError('draft.not_found')
      if (tx.draft.getRunningGeneration(draftId)) {
        throw new DraftError('draft.generation_in_progress')
      }
      if (!tx.draft.deleteDraft(userId, draftId)) throw new DraftError('draft.not_found')
    })
    await this.dependencies.assets.removeDraft(draftId).catch(() => undefined)
  }

  beginGeneration(userId: string, draftId: string): BeginDraftGenerationResult {
    return this.dependencies.unitOfWork.transaction((tx) => {
      const draft = tx.draft.getDraft(userId, draftId)
      if (!draft) throw new DraftError('draft.not_found')
      if (draft.status === 'submitted') throw new DraftError('draft.locked')
      if (tx.draft.getRunningGeneration(draftId)) {
        throw new DraftError('draft.generation_in_progress')
      }
      const workspace = tx.conversation.getWorkspace(userId, draft.workspaceId)
      if (!workspace) throw new DraftError('draft.workspace_not_found')
      const settings = settingsView(tx.draft.getSettings(userId))
      const nowMs = this.dependencies.clock.nowMs()
      const run: DraftGenerationRunRecord = {
        id: this.dependencies.ids.generate(),
        draftId,
        state: 'running',
        sourceDraftRevision: draft.revision,
        settingsRevision: settings.revision,
        provider: 'cursorcli',
        model: settings.model,
        errorCode: null,
        errorMessage: null,
        startedAtMs: nowMs,
        finishedAtMs: null
      }
      tx.draft.insertGeneration(run)
      if (
        !tx.draft.updateDraftState({
          userId,
          draftId,
          expectedRevision: draft.revision,
          expectedStatus: draft.status,
          status: 'generating',
          activeTreeId: draft.activeTreeId,
          updatedAtMs: nowMs
        })
      ) {
        throw new DraftError('draft.revision_conflict')
      }
      const attachments = tx.draft.listAttachments(userId, draftId)
      return {
        draft: { ...draft, status: 'generating', updatedAtMs: nowMs },
        workspace: { id: workspace.id, title: workspace.title, rootPath: workspace.rootPath },
        attachments: attachments.map((attachment) => ({
          ...attachment,
          absolutePath: this.dependencies.assets.resolveDraftAttachment(
            attachment.storageRelativePath
          )
        })),
        run,
        plannerPrompt: settings.plannerPrompt.value,
        skillsManual: settings.skillsManual.value
      }
    })
  }

  completeGeneration(
    userId: string,
    draftId: string,
    runId: string,
    tree: ExecutionTree,
    snapshots: { readonly plannerPrompt: string; readonly skillsManual: string }
  ): DraftExecutionTreeRecord {
    return this.dependencies.unitOfWork.transaction((tx) => {
      const draft = tx.draft.getDraft(userId, draftId)
      const run = tx.draft.getRunningGeneration(draftId)
      if (!draft || !run || run.id !== runId) {
        throw new DraftError('draft.generation_not_found')
      }
      if (draft.revision !== run.sourceDraftRevision || draft.status !== 'generating') {
        throw new DraftError('draft.revision_conflict')
      }
      const nowMs = this.dependencies.clock.nowMs()
      const record: DraftExecutionTreeRecord = {
        id: this.dependencies.ids.generate(),
        draftId,
        generationRunId: runId,
        treeRevision: tx.draft.nextTreeRevision(draftId),
        sourceDraftRevision: run.sourceDraftRevision,
        schemaVersion: 1,
        treeJson: JSON.stringify(tree),
        plannerPromptSnapshot: snapshots.plannerPrompt,
        skillsManualSnapshot: snapshots.skillsManual,
        model: run.model,
        createdAtMs: nowMs
      }
      tx.draft.insertExecutionTree(record)
      if (
        !tx.draft.finishGeneration({
          runId,
          state: 'completed',
          errorCode: null,
          errorMessage: null,
          finishedAtMs: nowMs
        }) ||
        !tx.draft.updateDraftState({
          userId,
          draftId,
          expectedRevision: draft.revision,
          expectedStatus: 'generating',
          status: 'tree_ready',
          activeTreeId: record.id,
          updatedAtMs: nowMs
        })
      ) {
        throw new DraftError('draft.revision_conflict')
      }
      return record
    })
  }

  failGeneration(
    userId: string,
    draftId: string,
    runId: string,
    input: { readonly cancelled: boolean; readonly code: string; readonly message: string }
  ): void {
    this.dependencies.unitOfWork.transaction((tx) => {
      const draft = tx.draft.getDraft(userId, draftId)
      const run = tx.draft.getRunningGeneration(draftId)
      if (!draft || !run || run.id !== runId) return
      const nowMs = this.dependencies.clock.nowMs()
      tx.draft.finishGeneration({
        runId,
        state: input.cancelled ? 'cancelled' : 'failed',
        errorCode: input.code.slice(0, 160),
        errorMessage: input.message.slice(0, 2_000),
        finishedAtMs: nowMs
      })
      tx.draft.updateDraftState({
        userId,
        draftId,
        expectedRevision: draft.revision,
        expectedStatus: 'generating',
        status: draft.activeTreeId ? 'tree_ready' : 'editing',
        activeTreeId: draft.activeTreeId,
        updatedAtMs: nowMs
      })
    })
  }

  async confirmExecutionTree(
    userId: string,
    draftId: string,
    input: { readonly expectedRevision: number; readonly treeId: string }
  ): Promise<JobIntakeHandoffView> {
    const prepared = this.dependencies.unitOfWork.transaction((tx) => {
      const existing = tx.jobIntake.getBySourceDraftId(draftId)
      if (existing) {
        if (existing.sourceUserId !== userId) throw new DraftError('draft.not_found')
        return {
          existing: handoffView(existing, tx.jobIntake.listAttachments(existing.id))
        } as const
      }
      const draft = tx.draft.getDraft(userId, draftId)
      if (!draft) throw new DraftError('draft.not_found')
      if (draft.revision !== input.expectedRevision) {
        throw new DraftError('draft.revision_conflict')
      }
      if (draft.status !== 'tree_ready' || draft.activeTreeId !== input.treeId) {
        throw new DraftError('draft.tree_not_ready')
      }
      const tree = tx.draft.getExecutionTree(userId, draftId, input.treeId)
      if (!tree || tree.sourceDraftRevision !== draft.revision) {
        throw new DraftError('draft.tree_stale')
      }
      const workspace = tx.conversation.getWorkspace(userId, draft.workspaceId)
      if (!workspace) throw new DraftError('draft.workspace_not_found')
      return {
        draft,
        tree,
        workspace,
        attachments: tx.draft.listAttachments(userId, draftId)
      } as const
    })
    if ('existing' in prepared && prepared.existing) return prepared.existing

    const handoffId = this.dependencies.ids.generate()
    const staged = await this.dependencies.assets.stageJobIntakeAssets({
      handoffId,
      attachments: prepared.attachments
    })
    try {
      const nowMs = this.dependencies.clock.nowMs()
      const result = this.dependencies.unitOfWork.transaction((tx) => {
        const existing = tx.jobIntake.getBySourceDraftId(draftId)
        if (existing) {
          if (existing.sourceUserId !== userId) throw new DraftError('draft.not_found')
          return {
            won: false as const,
            view: handoffView(existing, tx.jobIntake.listAttachments(existing.id))
          }
        }
        const current = tx.draft.getDraft(userId, draftId)
        if (
          !current ||
          current.revision !== prepared.draft.revision ||
          current.status !== 'tree_ready' ||
          current.activeTreeId !== prepared.tree.id
        ) {
          throw new DraftError('draft.confirm_conflict')
        }
        const intakeAttachments: JobIntakeAttachmentRecord[] = staged.assets.map((asset) => ({
          id: this.dependencies.ids.generate(),
          handoffId,
          sourceAttachmentId: asset.sourceAttachment.id,
          displayName: asset.sourceAttachment.displayName,
          mediaType: asset.sourceAttachment.mediaType,
          sizeBytes: asset.sourceAttachment.sizeBytes,
          sha256: asset.sourceAttachment.sha256,
          storageRelativePath: asset.storageRelativePath,
          createdAtMs: nowMs
        }))
        const handoff: JobIntakeHandoffRecord = {
          id: handoffId,
          sourceDraftId: draftId,
          sourceUserId: userId,
          sourceWorkspaceId: prepared.draft.workspaceId,
          sourceTreeId: prepared.tree.id,
          sourceDraftRevision: prepared.draft.revision,
          sourceTreeRevision: prepared.tree.treeRevision,
          state: 'pending',
          draftSnapshotJson: JSON.stringify({
            schemaVersion: 1,
            sourceDraftId: draftId,
            sourceThreadId: prepared.draft.sourceThreadId,
            workspace: {
              id: prepared.workspace.id,
              title: prepared.workspace.title,
              rootPath: prepared.workspace.rootPath
            },
            content: {
              title: prepared.draft.title,
              objective: prepared.draft.objective,
              requirements: prepared.draft.requirements,
              constraints: prepared.draft.constraints,
              acceptanceCriteria: prepared.draft.acceptanceCriteria
            },
            planningProvenance: {
              treeId: prepared.tree.id,
              treeRevision: prepared.tree.treeRevision,
              draftRevision: prepared.tree.sourceDraftRevision,
              model: prepared.tree.model,
              plannerPrompt: prepared.tree.plannerPromptSnapshot,
              skillsManual: prepared.tree.skillsManualSnapshot
            },
            attachments: intakeAttachments
          }),
          executionTreeJson: prepared.tree.treeJson,
          createdAtMs: nowMs,
          acceptedAtMs: null,
          rejectedAtMs: null,
          rejectionCode: null
        }
        tx.jobIntake.insertHandoff(handoff)
        for (const attachment of intakeAttachments) tx.jobIntake.insertAttachment(attachment)
        if (
          !tx.draft.updateDraftState({
            userId,
            draftId,
            expectedRevision: prepared.draft.revision,
            expectedStatus: 'tree_ready',
            status: 'submitted',
            activeTreeId: prepared.tree.id,
            submittedHandoffId: handoffId,
            submittedAtMs: nowMs,
            updatedAtMs: nowMs
          })
        ) {
          throw new DraftError('draft.confirm_conflict')
        }
        return { won: true as const, view: handoffView(handoff, intakeAttachments) }
      })
      if (!result.won) await staged.cleanup().catch(() => undefined)
      return result.view
    } catch (error) {
      await staged.cleanup().catch(() => undefined)
      throw error
    }
  }
}
