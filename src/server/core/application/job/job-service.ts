import type { ExecutionTree } from '../../domain/draft'
import {
  defaultJobSettings,
  JobError,
  type JobItemSnapshot,
  type JobSettings,
  type JobSnapshot,
  type RepairTask,
  type VerificationResult,
  type WorkResult,
  validateJobSettingsInput
} from '../../domain/job'
import type {
  Clock,
  ConversationWorkspaceRecord,
  IdGenerator,
  JobAttachmentRecord,
  JobEventRecord,
  JobIntakeHandoffRecord,
  JobRecord,
  JobSettingsRecord,
  JobWorkItemRecord,
  JobWorkspaceLeaseRecord,
  UnitOfWork
} from '../ports'

const MAX_REPAIR_GENERATIONS = 2
type EventListener = (event: JobEventRecord) => void

export interface ClaimedJob {
  readonly job: JobRecord
  readonly lease: JobWorkspaceLeaseRecord
}

export interface RunningJobItem {
  readonly job: JobRecord
  readonly item: JobWorkItemRecord
  readonly workspace: ConversationWorkspaceRecord
  readonly lease: JobWorkspaceLeaseRecord
  readonly attachments: readonly JobAttachmentRecord[]
  readonly priorItems: readonly JobWorkItemRecord[]
}

function effectiveSettings(record: JobSettingsRecord | null, nowMs = 0): JobSettings {
  const defaults = defaultJobSettings(nowMs)
  if (!record) return defaults
  return {
    maxConcurrentJobs: record.maxConcurrentJobs,
    work: {
      provider: record.workProvider,
      model: record.workModel,
      prompt: record.workPrompt ?? defaults.work.prompt,
      skillsManual: record.workSkillsManual ?? defaults.work.skillsManual
    },
    workValidation: {
      enabled: record.workValidationEnabled,
      provider: record.workValidationProvider,
      model: record.workValidationModel,
      prompt: record.workValidationPrompt ?? defaults.workValidation.prompt,
      skillsManual: record.workValidationSkillsManual ?? defaults.workValidation.skillsManual
    },
    sliceValidation: {
      enabled: record.sliceValidationEnabled,
      provider: record.sliceValidationProvider,
      model: record.sliceValidationModel,
      prompt: record.sliceValidationPrompt ?? defaults.sliceValidation.prompt,
      skillsManual: record.sliceValidationSkillsManual ?? defaults.sliceValidation.skillsManual
    },
    milestoneValidation: {
      enabled: record.milestoneValidationEnabled,
      provider: record.milestoneValidationProvider,
      model: record.milestoneValidationModel,
      prompt: record.milestoneValidationPrompt ?? defaults.milestoneValidation.prompt,
      skillsManual:
        record.milestoneValidationSkillsManual ?? defaults.milestoneValidation.skillsManual
    },
    revision: record.revision,
    updatedAtMs: record.updatedAtMs
  }
}

function storedText(value: string, fallback: string): string | null {
  return value === fallback ? null : value
}

function settingsRecord(userId: string, settings: JobSettings): JobSettingsRecord {
  const defaults = defaultJobSettings()
  return {
    userId,
    maxConcurrentJobs: settings.maxConcurrentJobs,
    workProvider: settings.work.provider,
    workModel: settings.work.model,
    workPrompt: storedText(settings.work.prompt, defaults.work.prompt),
    workSkillsManual: storedText(settings.work.skillsManual, defaults.work.skillsManual),
    workValidationEnabled: settings.workValidation.enabled,
    workValidationProvider: settings.workValidation.provider,
    workValidationModel: settings.workValidation.model,
    workValidationPrompt: storedText(
      settings.workValidation.prompt,
      defaults.workValidation.prompt
    ),
    workValidationSkillsManual: storedText(
      settings.workValidation.skillsManual,
      defaults.workValidation.skillsManual
    ),
    sliceValidationEnabled: settings.sliceValidation.enabled,
    sliceValidationProvider: settings.sliceValidation.provider,
    sliceValidationModel: settings.sliceValidation.model,
    sliceValidationPrompt: storedText(
      settings.sliceValidation.prompt,
      defaults.sliceValidation.prompt
    ),
    sliceValidationSkillsManual: storedText(
      settings.sliceValidation.skillsManual,
      defaults.sliceValidation.skillsManual
    ),
    milestoneValidationEnabled: settings.milestoneValidation.enabled,
    milestoneValidationProvider: settings.milestoneValidation.provider,
    milestoneValidationModel: settings.milestoneValidation.model,
    milestoneValidationPrompt: storedText(
      settings.milestoneValidation.prompt,
      defaults.milestoneValidation.prompt
    ),
    milestoneValidationSkillsManual: storedText(
      settings.milestoneValidation.skillsManual,
      defaults.milestoneValidation.skillsManual
    ),
    revision: settings.revision,
    updatedAtMs: settings.updatedAtMs
  }
}

function jsonList(value: string): string[] {
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : []
}

function itemSnapshot(record: JobWorkItemRecord): JobItemSnapshot {
  let result: JobItemSnapshot['result'] = null
  if (record.resultJson) {
    try {
      result = JSON.parse(record.resultJson) as JobItemSnapshot['result']
    } catch {
      result = null
    }
  }
  return {
    id: record.id,
    sequence: record.sequence,
    kind: record.kind,
    treeTaskId: record.treeTaskId,
    scopeId: record.scopeId,
    parentItemId: record.parentItemId,
    title: record.title,
    objective: record.objective,
    files: jsonList(record.filesJson),
    acceptanceCriteria: jsonList(record.acceptanceCriteriaJson),
    attachmentIds: jsonList(record.attachmentIdsJson),
    state: record.state,
    attempt: record.attempt,
    repairGeneration: record.repairGeneration,
    provider: record.providerCode,
    model: record.model,
    result,
    error:
      record.errorCode && record.errorMessage
        ? { code: record.errorCode, message: record.errorMessage }
        : null
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function draftSnapshot(handoff: JobIntakeHandoffRecord): {
  readonly title: string
  readonly summary: string
} {
  try {
    const parsed = JSON.parse(handoff.draftSnapshotJson) as {
      content?: { title?: unknown; objective?: unknown }
    }
    return {
      title:
        typeof parsed.content?.title === 'string' && parsed.content.title.trim()
          ? parsed.content.title.trim()
          : 'Untitled Job',
      summary: typeof parsed.content?.objective === 'string' ? parsed.content.objective.trim() : ''
    }
  } catch {
    throw new JobError('job.handoff_snapshot_invalid')
  }
}

export class JobService {
  private readonly listeners = new Set<EventListener>()

  constructor(
    private readonly dependencies: {
      readonly unitOfWork: UnitOfWork
      readonly clock: Clock
      readonly ids: IdGenerator
    }
  ) {}

  getSettings(userId: string): JobSettings {
    return effectiveSettings(
      this.dependencies.unitOfWork.transaction((tx) => tx.job.getSettings(userId))
    )
  }

  updateSettings(userId: string, value: unknown, expectedRevision: number): JobSettings {
    const current = this.getSettings(userId)
    if (current.revision !== expectedRevision) {
      throw new JobError('job.settings_conflict')
    }
    const validated = validateJobSettingsInput(value, current)
    const next: JobSettings = {
      ...validated,
      revision: current.revision + 1,
      updatedAtMs: this.dependencies.clock.nowMs()
    }
    const inserted = current.revision === 0
    const saved = this.dependencies.unitOfWork.transaction((tx) =>
      tx.job.putSettings(settingsRecord(userId, next), inserted ? null : current.revision)
    )
    if (!saved) throw new JobError('job.settings_conflict')
    this.publish(userId, null, 'settings.updated', { revision: next.revision })
    return next
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  listEvents(userId: string, afterId: number, limit = 100): JobEventRecord[] {
    return this.dependencies.unitOfWork.transaction((tx) =>
      tx.job.listEvents(userId, Math.max(0, afterId), Math.min(250, Math.max(1, limit)))
    )
  }

  reconcileInterrupted(): number {
    return this.dependencies.unitOfWork.transaction((tx) =>
      tx.job.resetInterrupted(this.dependencies.clock.nowMs())
    )
  }

  acceptAllPending(): JobSnapshot[] {
    const ids = this.dependencies.unitOfWork.transaction((tx) =>
      tx.jobIntake.listPending().map((handoff) => handoff.id)
    )
    return ids.map((id) => this.acceptHandoff(id))
  }

  acceptHandoff(handoffId: string): JobSnapshot {
    const accepted = this.dependencies.unitOfWork.transaction((tx) => {
      const existing = tx.job.getJobByHandoff(handoffId)
      if (existing) return { record: existing, created: false }
      const handoff = tx.jobIntake.getById(handoffId)
      if (!handoff) throw new JobError('job.handoff_not_found')
      if (handoff.state !== 'pending') throw new JobError('job.handoff_not_pending')
      const workspace = tx.conversation.getWorkspace(
        handoff.sourceUserId,
        handoff.sourceWorkspaceId
      )
      if (!workspace) throw new JobError('job.workspace_not_found')

      let tree: ExecutionTree
      try {
        tree = JSON.parse(handoff.executionTreeJson) as ExecutionTree
      } catch {
        throw new JobError('job.execution_tree_invalid')
      }
      if (tree.schemaVersion !== 1 || !Array.isArray(tree.milestones)) {
        throw new JobError('job.execution_tree_invalid')
      }
      const nowMs = this.dependencies.clock.nowMs()
      const source = draftSnapshot(handoff)
      const jobId = this.dependencies.ids.generate()
      const record: JobRecord = {
        id: jobId,
        userId: handoff.sourceUserId,
        sourceHandoffId: handoff.id,
        workspaceId: handoff.sourceWorkspaceId,
        title: source.title,
        summary: source.summary,
        state: 'queued',
        revision: 1,
        queueOrder: tx.job.nextQueueOrder(),
        activeItemId: null,
        sourceSnapshotJson: handoff.draftSnapshotJson,
        executionTreeJson: handoff.executionTreeJson,
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        startedAtMs: null,
        finishedAtMs: null,
        deletedAtMs: null
      }
      const settings = effectiveSettings(tx.job.getSettings(handoff.sourceUserId), nowMs)
      tx.job.insertJob(record)
      tx.job.insertWorkItems(this.expandExecutionTree(jobId, tree, settings, nowMs))
      for (const attachment of tx.jobIntake.listAttachments(handoff.id)) {
        tx.job.insertAttachment({
          id: this.dependencies.ids.generate(),
          jobId,
          sourceAttachmentId: attachment.sourceAttachmentId,
          displayName: attachment.displayName,
          mediaType: attachment.mediaType,
          sizeBytes: attachment.sizeBytes,
          sha256: attachment.sha256,
          storageRelativePath: attachment.storageRelativePath,
          createdAtMs: nowMs
        })
      }
      if (!tx.jobIntake.markAccepted(handoff.id, nowMs)) {
        throw new JobError('job.handoff_conflict')
      }
      return { record, created: true }
    })
    if (accepted.created) {
      this.publish(accepted.record.userId, accepted.record.id, 'job.queued', {})
    }
    return this.getJob(accepted.record.userId, accepted.record.id)
  }

  private expandExecutionTree(
    jobId: string,
    tree: ExecutionTree,
    settings: JobSettings,
    nowMs: number
  ): JobWorkItemRecord[] {
    const items: JobWorkItemRecord[] = []
    let sequence = 1
    const base = (
      kind: JobWorkItemRecord['kind'],
      input: {
        treeTaskId?: string | null
        scopeId: string
        parentItemId?: string | null
        title: string
        objective: string
        files: readonly string[]
        acceptanceCriteria: readonly string[]
        attachmentIds: readonly string[]
        providerCode: JobWorkItemRecord['providerCode']
        model: string | null
        prompt: string
        skills: string
      }
    ): JobWorkItemRecord => ({
      id: this.dependencies.ids.generate(),
      jobId,
      sequence: sequence++,
      kind,
      treeTaskId: input.treeTaskId ?? null,
      scopeId: input.scopeId,
      parentItemId: input.parentItemId ?? null,
      title: input.title,
      objective: input.objective,
      filesJson: JSON.stringify(input.files),
      acceptanceCriteriaJson: JSON.stringify(input.acceptanceCriteria),
      attachmentIdsJson: JSON.stringify(input.attachmentIds),
      state: 'queued',
      attempt: 0,
      repairGeneration: 0,
      providerCode: input.providerCode,
      model: input.model,
      promptSnapshot: input.prompt,
      skillsManualSnapshot: input.skills,
      resultJson: null,
      errorCode: null,
      errorMessage: null,
      startedAtMs: null,
      finishedAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs
    })

    for (const milestone of tree.milestones) {
      const milestoneFiles: string[] = []
      const milestoneAttachments: string[] = []
      for (const slice of milestone.slices) {
        const sliceFiles: string[] = []
        const sliceAttachments: string[] = []
        for (const task of slice.tasks) {
          const work = base('work', {
            treeTaskId: task.id,
            scopeId: task.id,
            title: task.title,
            objective: task.objective,
            files: task.files,
            acceptanceCriteria: task.acceptanceCriteria,
            attachmentIds: task.attachmentIds,
            providerCode: settings.work.provider,
            model: settings.work.model,
            prompt: settings.work.prompt,
            skills: settings.work.skillsManual
          })
          items.push(work)
          sliceFiles.push(...task.files)
          sliceAttachments.push(...task.attachmentIds)
          milestoneFiles.push(...task.files)
          milestoneAttachments.push(...task.attachmentIds)
          if (settings.workValidation.enabled) {
            items.push(
              base('work_validation', {
                treeTaskId: task.id,
                scopeId: task.id,
                parentItemId: work.id,
                title: `验证 Work：${task.title}`,
                objective: task.objective,
                files: task.files,
                acceptanceCriteria: task.acceptanceCriteria,
                attachmentIds: task.attachmentIds,
                providerCode: settings.workValidation.provider,
                model: settings.workValidation.model,
                prompt: settings.workValidation.prompt,
                skills: settings.workValidation.skillsManual
              })
            )
          }
        }
        if (settings.sliceValidation.enabled) {
          items.push(
            base('slice_validation', {
              scopeId: slice.id,
              title: `验证 Slice：${slice.title}`,
              objective: slice.objective,
              files: unique(sliceFiles),
              acceptanceCriteria: [slice.successCriteria],
              attachmentIds: unique(sliceAttachments),
              providerCode: settings.sliceValidation.provider,
              model: settings.sliceValidation.model,
              prompt: settings.sliceValidation.prompt,
              skills: settings.sliceValidation.skillsManual
            })
          )
        }
      }
      if (settings.milestoneValidation.enabled) {
        items.push(
          base('milestone_validation', {
            scopeId: milestone.id,
            title: `验证 Milestone：${milestone.title}`,
            objective: milestone.objective,
            files: unique(milestoneFiles),
            acceptanceCriteria: [milestone.successCriteria],
            attachmentIds: unique(milestoneAttachments),
            providerCode: settings.milestoneValidation.provider,
            model: settings.milestoneValidation.model,
            prompt: settings.milestoneValidation.prompt,
            skills: settings.milestoneValidation.skillsManual
          })
        )
      }
    }
    if (items.length === 0) throw new JobError('job.execution_tree_empty')
    return items
  }

  listJobs(userId: string): JobSnapshot[] {
    return this.dependencies.unitOfWork.transaction((tx) => {
      const records = tx.job.listJobs(userId)
      const queued = records
        .filter((record) => record.state === 'queued')
        .sort((a, b) => a.queueOrder - b.queueOrder || a.createdAtMs - b.createdAtMs)
      const positions = new Map(queued.map((record, index) => [record.id, index + 1]))
      return records.map((record) =>
        this.snapshot(record, tx.job.listWorkItems(record.id), positions.get(record.id) ?? null)
      )
    })
  }

  getJob(userId: string, jobId: string): JobSnapshot {
    return this.dependencies.unitOfWork.transaction((tx) => {
      const record = tx.job.getJob(userId, jobId)
      if (!record || record.state === 'deleted') throw new JobError('job.not_found')
      const queued = tx.job
        .listJobs(userId)
        .filter((candidate) => candidate.state === 'queued')
        .sort((a, b) => a.queueOrder - b.queueOrder || a.createdAtMs - b.createdAtMs)
      const position = queued.findIndex((candidate) => candidate.id === jobId)
      return this.snapshot(record, tx.job.listWorkItems(jobId), position < 0 ? null : position + 1)
    })
  }

  private snapshot(
    record: JobRecord,
    items: readonly JobWorkItemRecord[],
    queuePosition: number | null
  ): JobSnapshot {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      title: record.title,
      summary: record.summary,
      state: record.state,
      revision: record.revision,
      queuePosition,
      activeItemId: record.activeItemId,
      completedItems: items.filter((item) => item.state === 'succeeded' || item.state === 'skipped')
        .length,
      totalItems: items.length,
      lastError:
        record.lastErrorCode && record.lastErrorMessage
          ? { code: record.lastErrorCode, message: record.lastErrorMessage }
          : null,
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
      startedAtMs: record.startedAtMs,
      finishedAtMs: record.finishedAtMs,
      items: items.map(itemSnapshot)
    }
  }

  listRunnable(limit: number): JobRecord[] {
    return this.dependencies.unitOfWork.transaction((tx) => tx.job.listRunnableJobs(limit))
  }

  tryClaim(jobId: string): ClaimedJob | null {
    const result = this.dependencies.unitOfWork.transaction((tx) => {
      const candidate = tx.job.listRunnableJobs(100).find((record) => record.id === jobId)
      if (!candidate || tx.job.getLeaseByWorkspace(candidate.workspaceId)) return null
      const nowMs = this.dependencies.clock.nowMs()
      const lease: JobWorkspaceLeaseRecord = {
        workspaceId: candidate.workspaceId,
        jobId: candidate.id,
        leaseId: this.dependencies.ids.generate(),
        acquiredAtMs: nowMs,
        heartbeatAtMs: nowMs
      }
      if (!tx.job.tryAcquireLease(lease)) return null
      if (
        !tx.job.updateJob({
          jobId,
          expectedRevision: candidate.revision,
          expectedStates: ['queued'],
          state: 'running',
          activeItemId: null,
          startedAtMs: candidate.startedAtMs ?? nowMs,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAtMs: nowMs
        })
      ) {
        tx.job.releaseLease(jobId)
        return null
      }
      const updated = tx.job.getJob(candidate.userId, jobId)
      return updated ? { job: updated, lease } : null
    })
    if (result) this.publish(result.job.userId, result.job.id, 'job.running', {})
    return result
  }

  beginNextItem(userId: string, jobId: string): RunningJobItem | null {
    const result = this.dependencies.unitOfWork.transaction((tx) => {
      const job = tx.job.getJob(userId, jobId)
      if (!job || job.state !== 'running') return null
      const lease = tx.job.getLeaseByJob(jobId)
      if (!lease || lease.workspaceId !== job.workspaceId) {
        throw new JobError('job.workspace_lease_missing')
      }
      const next = tx.job.getNextQueuedWorkItem(jobId)
      if (!next) return null
      const nowMs = this.dependencies.clock.nowMs()
      if (
        !tx.job.updateWorkItem({
          jobId,
          itemId: next.id,
          expectedStates: ['queued'],
          state: 'running',
          attempt: next.attempt + 1,
          errorCode: null,
          errorMessage: null,
          startedAtMs: nowMs,
          finishedAtMs: null,
          updatedAtMs: nowMs
        }) ||
        !tx.job.updateJob({
          jobId,
          expectedRevision: job.revision,
          expectedStates: ['running'],
          state: 'running',
          activeItemId: next.id,
          updatedAtMs: nowMs
        })
      ) {
        throw new JobError('job.concurrent_update')
      }
      const updatedJob = tx.job.getJob(userId, jobId)
      const updatedItem = tx.job.getWorkItem(jobId, next.id)
      const workspace = tx.conversation.getWorkspace(userId, job.workspaceId)
      if (!updatedJob || !updatedItem || !workspace) {
        throw new JobError('job.concurrent_update')
      }
      return {
        job: updatedJob,
        item: updatedItem,
        workspace,
        lease,
        attachments: tx.job.listAttachments(jobId),
        priorItems: tx.job
          .listWorkItems(jobId)
          .filter((item) => item.sequence < updatedItem.sequence)
      }
    })
    if (result) {
      this.publish(userId, jobId, 'item.running', {
        itemId: result.item.id,
        sequence: result.item.sequence
      })
    }
    return result
  }

  completeWork(userId: string, jobId: string, itemId: string, result: WorkResult): void {
    this.completeItem(userId, jobId, itemId, result)
  }

  completeVerification(
    userId: string,
    jobId: string,
    itemId: string,
    result: VerificationResult
  ): void {
    if (result.status === 'passed') {
      this.completeItem(userId, jobId, itemId, result)
      return
    }
    if (result.status === 'failed') {
      this.failItem(userId, jobId, itemId, 'job.verification_failed', result.summary, result)
      return
    }
    this.insertRepairs(userId, jobId, itemId, result)
  }

  private completeItem(
    userId: string,
    jobId: string,
    itemId: string,
    result: WorkResult | VerificationResult
  ): void {
    const state = this.dependencies.unitOfWork.transaction((tx) => {
      const job = tx.job.getJob(userId, jobId)
      const item = tx.job.getWorkItem(jobId, itemId)
      if (!job || !item || item.state !== 'running' || job.activeItemId !== itemId) {
        throw new JobError('job.concurrent_update')
      }
      const nowMs = this.dependencies.clock.nowMs()
      if (
        !tx.job.updateWorkItem({
          jobId,
          itemId,
          expectedStates: ['running'],
          state: 'succeeded',
          resultJson: JSON.stringify(result),
          errorCode: null,
          errorMessage: null,
          finishedAtMs: nowMs,
          updatedAtMs: nowMs
        })
      ) {
        throw new JobError('job.concurrent_update')
      }
      const hasNext = tx.job.getNextQueuedWorkItem(jobId) !== null
      const nextState = hasNext
        ? job.state === 'pause_requested'
          ? 'paused'
          : 'running'
        : 'succeeded'
      if (
        !tx.job.updateJob({
          jobId,
          expectedRevision: job.revision,
          expectedStates: ['running', 'pause_requested'],
          state: nextState,
          activeItemId: null,
          finishedAtMs: nextState === 'succeeded' ? nowMs : null,
          updatedAtMs: nowMs
        })
      ) {
        throw new JobError('job.concurrent_update')
      }
      if (nextState !== 'running') tx.job.releaseLease(jobId)
      return nextState
    })
    this.publish(userId, jobId, 'item.succeeded', { itemId })
    this.publish(userId, jobId, `job.${state}`, {})
  }

  private insertRepairs(
    userId: string,
    jobId: string,
    itemId: string,
    verdict: VerificationResult
  ): void {
    const state = this.dependencies.unitOfWork.transaction((tx) => {
      const job = tx.job.getJob(userId, jobId)
      const gate = tx.job.getWorkItem(jobId, itemId)
      if (!job || !gate || gate.state !== 'running' || job.activeItemId !== itemId) {
        throw new JobError('job.concurrent_update')
      }
      if (gate.repairGeneration >= MAX_REPAIR_GENERATIONS) {
        throw new JobError('job.repair_limit_reached')
      }
      const items = tx.job.listWorkItems(jobId)
      const template = items.find((item) => item.kind === 'work')
      if (!template) throw new JobError('job.repair_template_missing')
      const nowMs = this.dependencies.clock.nowMs()
      const generation = gate.repairGeneration + 1
      const repairs = verdict.repairTasks.map((repair) =>
        this.repairRecord(jobId, gate, template, repair, generation, nowMs)
      )
      if (
        !tx.job.updateWorkItem({
          jobId,
          itemId,
          expectedStates: ['running'],
          state: 'queued',
          repairGeneration: generation,
          resultJson: JSON.stringify(verdict),
          startedAtMs: null,
          finishedAtMs: null,
          updatedAtMs: nowMs
        })
      ) {
        throw new JobError('job.concurrent_update')
      }
      tx.job.insertWorkItemsBefore(jobId, gate.sequence, repairs)
      const nextState = job.state === 'pause_requested' ? 'paused' : 'running'
      if (
        !tx.job.updateJob({
          jobId,
          expectedRevision: job.revision,
          expectedStates: ['running', 'pause_requested'],
          state: nextState,
          activeItemId: null,
          updatedAtMs: nowMs
        })
      ) {
        throw new JobError('job.concurrent_update')
      }
      if (nextState === 'paused') tx.job.releaseLease(jobId)
      return { nextState, repairIds: repairs.map((repair) => repair.id) }
    })
    this.publish(userId, jobId, 'verification.repair_inserted', {
      gateItemId: itemId,
      repairItemIds: state.repairIds
    })
    if (state.nextState === 'paused') this.publish(userId, jobId, 'job.paused', {})
  }

  private repairRecord(
    jobId: string,
    gate: JobWorkItemRecord,
    workTemplate: JobWorkItemRecord,
    repair: RepairTask,
    generation: number,
    nowMs: number
  ): JobWorkItemRecord {
    return {
      id: this.dependencies.ids.generate(),
      jobId,
      sequence: gate.sequence,
      kind: 'work',
      treeTaskId: gate.treeTaskId,
      scopeId: gate.scopeId,
      parentItemId: gate.id,
      title: `[修复 ${generation}] ${repair.title}`,
      objective: repair.objective,
      filesJson: JSON.stringify(repair.files),
      acceptanceCriteriaJson: JSON.stringify(repair.acceptanceCriteria),
      attachmentIdsJson: gate.attachmentIdsJson,
      state: 'queued',
      attempt: 0,
      repairGeneration: generation,
      providerCode: workTemplate.providerCode,
      model: workTemplate.model,
      promptSnapshot: workTemplate.promptSnapshot,
      skillsManualSnapshot: workTemplate.skillsManualSnapshot,
      resultJson: null,
      errorCode: null,
      errorMessage: null,
      startedAtMs: null,
      finishedAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs
    }
  }

  failItem(
    userId: string,
    jobId: string,
    itemId: string,
    code: string,
    message: string,
    result?: WorkResult | VerificationResult
  ): void {
    this.dependencies.unitOfWork.transaction((tx) => {
      const job = tx.job.getJob(userId, jobId)
      const item = tx.job.getWorkItem(jobId, itemId)
      if (!job || !item || job.state === 'deleted') return
      const nowMs = this.dependencies.clock.nowMs()
      tx.job.updateWorkItem({
        jobId,
        itemId,
        expectedStates: ['running'],
        state: 'failed',
        resultJson: result ? JSON.stringify(result) : null,
        errorCode: code.slice(0, 160),
        errorMessage: message.slice(0, 4_000),
        finishedAtMs: nowMs,
        updatedAtMs: nowMs
      })
      tx.job.updateJob({
        jobId,
        expectedRevision: job.revision,
        expectedStates: ['running', 'pause_requested'],
        state: 'failed',
        activeItemId: itemId,
        lastErrorCode: code.slice(0, 160),
        lastErrorMessage: message.slice(0, 4_000),
        finishedAtMs: nowMs,
        updatedAtMs: nowMs
      })
      tx.job.releaseLease(jobId)
    })
    this.publish(userId, jobId, 'job.failed', { itemId, code, message })
  }

  interruptRunningItem(userId: string, jobId: string, itemId: string): void {
    const changed = this.dependencies.unitOfWork.transaction((tx) => {
      const job = tx.job.getJob(userId, jobId)
      const item = tx.job.getWorkItem(jobId, itemId)
      if (
        !job ||
        !item ||
        item.state !== 'running' ||
        job.state === 'deleted' ||
        job.activeItemId !== itemId
      ) {
        return false
      }
      const nowMs = this.dependencies.clock.nowMs()
      if (
        !tx.job.updateWorkItem({
          jobId,
          itemId,
          expectedStates: ['running'],
          state: 'queued',
          errorCode: 'job.interrupted',
          errorMessage: 'Execution stopped safely; continue resumes this same item.',
          startedAtMs: null,
          finishedAtMs: null,
          updatedAtMs: nowMs
        }) ||
        !tx.job.updateJob({
          jobId,
          expectedRevision: job.revision,
          expectedStates: ['running', 'pause_requested'],
          state: 'paused',
          activeItemId: null,
          lastErrorCode: 'job.interrupted',
          lastErrorMessage: 'Execution stopped safely; continue resumes this same item.',
          updatedAtMs: nowMs
        })
      ) {
        return false
      }
      tx.job.releaseLease(jobId)
      return true
    })
    if (changed) this.publish(userId, jobId, 'job.paused', { interruptedItemId: itemId })
  }

  requestPause(userId: string, jobId: string): JobSnapshot {
    const nextState = this.dependencies.unitOfWork.transaction((tx) => {
      const job = tx.job.getJob(userId, jobId)
      if (!job || job.state === 'deleted') throw new JobError('job.not_found')
      if (job.state === 'paused' || job.state === 'pause_requested') return job.state
      if (job.state !== 'queued' && job.state !== 'running') {
        throw new JobError('job.pause_invalid')
      }
      const nowMs = this.dependencies.clock.nowMs()
      const state = job.state === 'queued' ? 'paused' : 'pause_requested'
      if (
        !tx.job.updateJob({
          jobId,
          expectedRevision: job.revision,
          expectedStates: [job.state],
          state,
          activeItemId: job.activeItemId,
          updatedAtMs: nowMs
        })
      ) {
        throw new JobError('job.concurrent_update')
      }
      if (state === 'paused') tx.job.releaseLease(jobId)
      return state
    })
    this.publish(userId, jobId, `job.${nextState}`, {})
    return this.getJob(userId, jobId)
  }

  continueJob(userId: string, jobId: string): JobSnapshot {
    this.dependencies.unitOfWork.transaction((tx) => {
      const job = tx.job.getJob(userId, jobId)
      if (!job || job.state === 'deleted') throw new JobError('job.not_found')
      const nowMs = this.dependencies.clock.nowMs()
      if (job.state === 'pause_requested') {
        if (
          !tx.job.updateJob({
            jobId,
            expectedRevision: job.revision,
            expectedStates: ['pause_requested'],
            state: 'running',
            activeItemId: job.activeItemId,
            updatedAtMs: nowMs
          })
        ) {
          throw new JobError('job.concurrent_update')
        }
        return
      }
      if (job.state !== 'paused' && job.state !== 'failed') {
        throw new JobError('job.continue_invalid')
      }
      const failed = tx.job.listWorkItems(jobId).find((item) => item.state === 'failed')
      if (failed) {
        tx.job.updateWorkItem({
          jobId,
          itemId: failed.id,
          expectedStates: ['failed'],
          state: 'queued',
          errorCode: null,
          errorMessage: null,
          startedAtMs: null,
          finishedAtMs: null,
          updatedAtMs: nowMs
        })
      }
      if (
        !tx.job.updateJob({
          jobId,
          expectedRevision: job.revision,
          expectedStates: [job.state],
          state: 'queued',
          activeItemId: null,
          queueOrder: tx.job.nextQueueOrder(),
          lastErrorCode: null,
          lastErrorMessage: null,
          finishedAtMs: null,
          updatedAtMs: nowMs
        })
      ) {
        throw new JobError('job.concurrent_update')
      }
    })
    this.publish(userId, jobId, 'job.queued', { resumed: true })
    return this.getJob(userId, jobId)
  }

  deleteJob(userId: string, jobId: string): void {
    this.dependencies.unitOfWork.transaction((tx) => {
      const job = tx.job.getJob(userId, jobId)
      if (!job || job.state === 'deleted') throw new JobError('job.not_found')
      const nowMs = this.dependencies.clock.nowMs()
      if (
        !tx.job.updateJob({
          jobId,
          expectedRevision: job.revision,
          expectedStates: [job.state],
          state: 'deleted',
          activeItemId: null,
          deletedAtMs: nowMs,
          finishedAtMs: nowMs,
          updatedAtMs: nowMs
        })
      ) {
        throw new JobError('job.concurrent_update')
      }
      tx.job.releaseLease(jobId)
    })
    this.publish(userId, jobId, 'job.deleted', {})
  }

  workspaceHasActiveLease(workspaceId: string): boolean {
    return this.dependencies.unitOfWork.transaction(
      (tx) => tx.job.getLeaseByWorkspace(workspaceId) !== null
    )
  }

  assertWorkspaceRemovalAllowed(userId: string, workspaceId: string): void {
    const retainedBy = this.dependencies.unitOfWork.transaction((tx) =>
      tx.job.listJobs(userId, true).find((job) => job.workspaceId === workspaceId)
    )
    if (retainedBy) {
      throw new JobError('job.workspace_retained', {
        jobId: retainedBy.id,
        state: retainedBy.state
      })
    }
  }

  heartbeat(jobId: string): void {
    this.dependencies.unitOfWork.transaction((tx) => {
      tx.job.heartbeatLease(jobId, this.dependencies.clock.nowMs())
    })
  }

  private publish(
    userId: string,
    jobId: string | null,
    eventType: string,
    payload: Readonly<Record<string, unknown>>
  ): void {
    const record = this.dependencies.unitOfWork.transaction((tx) => {
      const createdAtMs = this.dependencies.clock.nowMs()
      const payloadJson = JSON.stringify(payload)
      const id = tx.job.appendEvent({
        userId,
        jobId,
        eventType,
        payloadJson,
        createdAtMs
      })
      return { id, userId, jobId, eventType, payloadJson, createdAtMs }
    })
    for (const listener of this.listeners) listener(record)
  }
}
