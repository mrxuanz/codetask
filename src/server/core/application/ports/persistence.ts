export interface AuthUserRecord {
  readonly id: string
  readonly username: string
  readonly normalizedUsername: string
  readonly passwordHash: string
  readonly passwordVersion: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly disabledAtMs: number | null
}

export interface AuthSessionRecord {
  readonly id: string
  readonly userId: string
  readonly tokenDigest: string
  readonly createdAtMs: number
  readonly lastSeenAtMs: number
  readonly expiresAtMs: number
  readonly revokedAtMs: number | null
  readonly revokeReason: string | null
}

export interface AuthThrottleRecord {
  readonly key: string
  readonly windowStartedAtMs: number
  readonly requestCount: number
  readonly failureCount: number
  readonly captchaRequired: boolean
  readonly lockedUntilMs: number | null
  readonly updatedAtMs: number
}

export interface AuthChallengeRecord {
  readonly id: string
  readonly scopeKey: string
  readonly answerDigest: string
  readonly attempts: number
  readonly maxAttempts: number
  readonly expiresAtMs: number
  readonly consumedAtMs: number | null
  readonly createdAtMs: number
}

export interface AuthAuditRecord {
  readonly eventType: string
  readonly userId: string | null
  readonly subjectDigest: string | null
  readonly scopeDigest: string | null
  readonly success: boolean
  readonly reasonCode: string
  readonly createdAtMs: number
}

export interface AuthCleanupResult {
  readonly sessions: number
  readonly challenges: number
  readonly throttles: number
}

export interface ConversationSettingsRecord {
  readonly userId: string
  readonly provider: 'cursorcli'
  readonly model: string | null
  readonly revision: number
  readonly updatedAtMs: number
}

export interface ConversationWorkspaceRecord {
  readonly id: string
  readonly userId: string
  readonly title: string
  readonly rootPath: string
  readonly canonicalKey: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface ConversationThreadRecord {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly provider: 'cursorcli'
  readonly model: string | null
  readonly runtimeSessionId: string | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly lastMessageAtMs: number | null
}

export interface ConversationMessageRecord {
  readonly id: string
  readonly threadId: string
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly sequence: number
  readonly createdAtMs: number
}

export interface ConversationTurnRecord {
  readonly id: string
  readonly threadId: string
  readonly userMessageId: string
  readonly state: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly provider: 'cursorcli'
  readonly model: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly startedAtMs: number
  readonly finishedAtMs: number | null
}

export interface DraftSettingsRecord {
  readonly userId: string
  readonly provider: 'cursorcli'
  readonly model: string | null
  readonly plannerPrompt: string | null
  readonly skillsManual: string | null
  readonly revision: number
  readonly updatedAtMs: number
}

export type DraftStatus = 'editing' | 'generating' | 'tree_ready' | 'submitted'

export interface DraftRecord {
  readonly id: string
  readonly userId: string
  readonly workspaceId: string
  readonly sourceThreadId: string | null
  readonly title: string
  readonly objective: string
  readonly requirements: string
  readonly constraints: string
  readonly acceptanceCriteria: string
  readonly status: DraftStatus
  readonly revision: number
  readonly activeTreeId: string | null
  readonly submittedHandoffId: string | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly submittedAtMs: number | null
}

export interface DraftAttachmentRecord {
  readonly id: string
  readonly draftId: string
  readonly displayName: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly storageRelativePath: string
  readonly createdAtMs: number
}

export interface DraftGenerationRunRecord {
  readonly id: string
  readonly draftId: string
  readonly state: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly sourceDraftRevision: number
  readonly settingsRevision: number
  readonly provider: 'cursorcli'
  readonly model: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly startedAtMs: number
  readonly finishedAtMs: number | null
}

export interface DraftExecutionTreeRecord {
  readonly id: string
  readonly draftId: string
  readonly generationRunId: string
  readonly treeRevision: number
  readonly sourceDraftRevision: number
  readonly schemaVersion: 1
  readonly treeJson: string
  readonly plannerPromptSnapshot: string
  readonly skillsManualSnapshot: string
  readonly model: string | null
  readonly createdAtMs: number
}

export interface JobIntakeHandoffRecord {
  readonly id: string
  readonly sourceDraftId: string
  readonly sourceUserId: string
  readonly sourceWorkspaceId: string
  readonly sourceTreeId: string
  readonly sourceDraftRevision: number
  readonly sourceTreeRevision: number
  readonly state: 'pending' | 'accepted' | 'rejected'
  readonly draftSnapshotJson: string
  readonly executionTreeJson: string
  readonly createdAtMs: number
  readonly acceptedAtMs: number | null
  readonly rejectedAtMs: number | null
  readonly rejectionCode: string | null
}

export interface JobIntakeAttachmentRecord {
  readonly id: string
  readonly handoffId: string
  readonly sourceAttachmentId: string
  readonly displayName: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly storageRelativePath: string
  readonly createdAtMs: number
}

export type JobStateRecord =
  | 'queued'
  | 'running'
  | 'pause_requested'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'deleted'

export interface JobSettingsRecord {
  readonly userId: string
  readonly maxConcurrentJobs: 1 | 2
  readonly workProvider: 'codex' | 'claude-code' | 'opencode' | 'cursorcli'
  readonly workModel: string | null
  readonly workPrompt: string | null
  readonly workSkillsManual: string | null
  readonly workValidationEnabled: boolean
  readonly workValidationProvider: 'codex' | 'claude-code' | 'opencode' | 'cursorcli'
  readonly workValidationModel: string | null
  readonly workValidationPrompt: string | null
  readonly workValidationSkillsManual: string | null
  readonly sliceValidationEnabled: boolean
  readonly sliceValidationProvider: 'codex' | 'claude-code' | 'opencode' | 'cursorcli'
  readonly sliceValidationModel: string | null
  readonly sliceValidationPrompt: string | null
  readonly sliceValidationSkillsManual: string | null
  readonly milestoneValidationEnabled: boolean
  readonly milestoneValidationProvider: 'codex' | 'claude-code' | 'opencode' | 'cursorcli'
  readonly milestoneValidationModel: string | null
  readonly milestoneValidationPrompt: string | null
  readonly milestoneValidationSkillsManual: string | null
  readonly revision: number
  readonly updatedAtMs: number
}

export interface JobRecord {
  readonly id: string
  readonly userId: string
  readonly sourceHandoffId: string
  readonly workspaceId: string
  readonly title: string
  readonly summary: string
  readonly state: JobStateRecord
  readonly revision: number
  readonly queueOrder: number
  readonly activeItemId: string | null
  readonly sourceSnapshotJson: string
  readonly executionTreeJson: string
  readonly lastErrorCode: string | null
  readonly lastErrorMessage: string | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly deletedAtMs: number | null
}

export type JobItemKindRecord =
  | 'work'
  | 'work_validation'
  | 'slice_validation'
  | 'milestone_validation'

export interface JobWorkItemRecord {
  readonly id: string
  readonly jobId: string
  readonly sequence: number
  readonly kind: JobItemKindRecord
  readonly treeTaskId: string | null
  readonly scopeId: string
  readonly parentItemId: string | null
  readonly title: string
  readonly objective: string
  readonly filesJson: string
  readonly acceptanceCriteriaJson: string
  readonly attachmentIdsJson: string
  readonly state: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
  readonly attempt: number
  readonly repairGeneration: number
  readonly providerCode: 'codex' | 'claude-code' | 'opencode' | 'cursorcli'
  readonly model: string | null
  readonly promptSnapshot: string
  readonly skillsManualSnapshot: string
  readonly resultJson: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface JobAttachmentRecord {
  readonly id: string
  readonly jobId: string
  readonly sourceAttachmentId: string
  readonly displayName: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly storageRelativePath: string
  readonly createdAtMs: number
}

export interface JobWorkspaceLeaseRecord {
  readonly workspaceId: string
  readonly jobId: string
  readonly leaseId: string
  readonly acquiredAtMs: number
  readonly heartbeatAtMs: number
}

export interface JobEventRecord {
  readonly id: number
  readonly userId: string
  readonly jobId: string | null
  readonly eventType: string
  readonly payloadJson: string
  readonly createdAtMs: number
}

export interface ConversationRepository {
  getSettings(userId: string): ConversationSettingsRecord | null
  putSettings(record: ConversationSettingsRecord): void
  listWorkspaces(userId: string): ConversationWorkspaceRecord[]
  getWorkspace(userId: string, workspaceId: string): ConversationWorkspaceRecord | null
  getWorkspaceByCanonicalKey(
    userId: string,
    canonicalKey: string
  ): ConversationWorkspaceRecord | null
  insertWorkspace(record: ConversationWorkspaceRecord): void
  deleteWorkspace(userId: string, workspaceId: string): boolean
  listThreads(userId: string, workspaceId: string): ConversationThreadRecord[]
  getThread(userId: string, threadId: string): ConversationThreadRecord | null
  insertThread(record: ConversationThreadRecord): void
  updateThreadTitle(userId: string, threadId: string, title: string, updatedAtMs: number): boolean
  deleteThread(userId: string, threadId: string): boolean
  listMessages(userId: string, threadId: string): ConversationMessageRecord[]
  nextMessageSequence(threadId: string): number
  insertMessage(record: ConversationMessageRecord): void
  getRunningTurn(threadId: string): ConversationTurnRecord | null
  insertTurn(record: ConversationTurnRecord): void
  completeTurn(input: {
    readonly turnId: string
    readonly threadId: string
    readonly assistantMessage: ConversationMessageRecord
    readonly runtimeSessionId: string | null
    readonly finishedAtMs: number
  }): boolean
  failTurn(input: {
    readonly turnId: string
    readonly state: 'failed' | 'cancelled'
    readonly errorCode: string
    readonly errorMessage: string
    readonly finishedAtMs: number
  }): boolean
}

export interface DraftRepository {
  getSettings(userId: string): DraftSettingsRecord | null
  putSettings(record: DraftSettingsRecord): void
  listDrafts(userId: string, workspaceId?: string): DraftRecord[]
  getDraft(userId: string, draftId: string): DraftRecord | null
  insertDraft(record: DraftRecord): void
  updateDraftContent(record: DraftRecord, expectedRevision: number): boolean
  updateDraftState(input: {
    readonly userId: string
    readonly draftId: string
    readonly expectedRevision: number
    readonly expectedStatus?: DraftStatus | undefined
    readonly status: DraftStatus
    readonly activeTreeId: string | null
    readonly submittedHandoffId?: string | null | undefined
    readonly submittedAtMs?: number | null | undefined
    readonly updatedAtMs: number
  }): boolean
  deleteDraft(userId: string, draftId: string): boolean
  listAttachments(userId: string, draftId: string): DraftAttachmentRecord[]
  getAttachment(userId: string, draftId: string, attachmentId: string): DraftAttachmentRecord | null
  insertAttachment(record: DraftAttachmentRecord): void
  deleteAttachment(draftId: string, attachmentId: string): boolean
  getRunningGeneration(draftId: string): DraftGenerationRunRecord | null
  insertGeneration(record: DraftGenerationRunRecord): void
  finishGeneration(input: {
    readonly runId: string
    readonly state: 'completed' | 'failed' | 'cancelled'
    readonly errorCode: string | null
    readonly errorMessage: string | null
    readonly finishedAtMs: number
  }): boolean
  nextTreeRevision(draftId: string): number
  insertExecutionTree(record: DraftExecutionTreeRecord): void
  getExecutionTree(userId: string, draftId: string, treeId: string): DraftExecutionTreeRecord | null
  getActiveExecutionTree(userId: string, draftId: string): DraftExecutionTreeRecord | null
}

/**
 * Durable boundary owned by the future Job module.
 * Draft planning can only append immutable pending handoffs; it cannot execute them.
 */
export interface JobIntakeRepository {
  getById(handoffId: string): JobIntakeHandoffRecord | null
  getBySourceDraftId(sourceDraftId: string): JobIntakeHandoffRecord | null
  listPending(): JobIntakeHandoffRecord[]
  insertHandoff(record: JobIntakeHandoffRecord): void
  markAccepted(handoffId: string, acceptedAtMs: number): boolean
  insertAttachment(record: JobIntakeAttachmentRecord): void
  listAttachments(handoffId: string): JobIntakeAttachmentRecord[]
}

export interface JobRepository {
  getSettings(userId: string): JobSettingsRecord | null
  putSettings(record: JobSettingsRecord, expectedRevision: number | null): boolean
  nextQueueOrder(): number
  insertJob(record: JobRecord): void
  getJob(userId: string, jobId: string): JobRecord | null
  getJobByHandoff(handoffId: string): JobRecord | null
  listJobs(userId: string, includeDeleted?: boolean): JobRecord[]
  listRunnableJobs(limit: number): JobRecord[]
  updateJob(input: {
    readonly jobId: string
    readonly expectedRevision: number
    readonly expectedStates: readonly JobStateRecord[]
    readonly state: JobStateRecord
    readonly activeItemId: string | null
    readonly queueOrder?: number | undefined
    readonly lastErrorCode?: string | null | undefined
    readonly lastErrorMessage?: string | null | undefined
    readonly startedAtMs?: number | null | undefined
    readonly finishedAtMs?: number | null | undefined
    readonly deletedAtMs?: number | null | undefined
    readonly updatedAtMs: number
  }): boolean
  insertWorkItems(records: readonly JobWorkItemRecord[]): void
  listWorkItems(jobId: string): JobWorkItemRecord[]
  getWorkItem(jobId: string, itemId: string): JobWorkItemRecord | null
  getNextQueuedWorkItem(jobId: string): JobWorkItemRecord | null
  updateWorkItem(input: {
    readonly jobId: string
    readonly itemId: string
    readonly expectedStates: readonly JobWorkItemRecord['state'][]
    readonly state: JobWorkItemRecord['state']
    readonly attempt?: number | undefined
    readonly repairGeneration?: number | undefined
    readonly resultJson?: string | null | undefined
    readonly errorCode?: string | null | undefined
    readonly errorMessage?: string | null | undefined
    readonly startedAtMs?: number | null | undefined
    readonly finishedAtMs?: number | null | undefined
    readonly updatedAtMs: number
  }): boolean
  insertWorkItemsBefore(
    jobId: string,
    beforeSequence: number,
    records: readonly JobWorkItemRecord[]
  ): void
  resetInterrupted(nowMs: number): number
  insertAttachment(record: JobAttachmentRecord): void
  listAttachments(jobId: string): JobAttachmentRecord[]
  tryAcquireLease(record: JobWorkspaceLeaseRecord): boolean
  getLeaseByWorkspace(workspaceId: string): JobWorkspaceLeaseRecord | null
  getLeaseByJob(jobId: string): JobWorkspaceLeaseRecord | null
  heartbeatLease(jobId: string, heartbeatAtMs: number): boolean
  releaseLease(jobId: string): boolean
  releaseAllLeases(): number
  appendEvent(record: Omit<JobEventRecord, 'id'>): number
  listEvents(userId: string, afterId: number, limit: number): JobEventRecord[]
}

export interface AuthRepository {
  getUser(): AuthUserRecord | null
  getUserByNormalizedUsername(normalizedUsername: string): AuthUserRecord | null
  insertUser(record: AuthUserRecord): void
  updatePassword(input: {
    readonly userId: string
    readonly expectedVersion: number
    readonly passwordHash: string
    readonly updatedAtMs: number
  }): boolean
  getSessionByDigest(tokenDigest: string): AuthSessionRecord | null
  insertSession(record: AuthSessionRecord): void
  touchSession(id: string, lastSeenAtMs: number): boolean
  revokeSessionByDigest(tokenDigest: string, revokedAtMs: number, reason: string): boolean
  revokeAllSessions(userId: string, revokedAtMs: number, reason: string): number
  revokeExcessSessions(
    userId: string,
    keepNewest: number,
    revokedAtMs: number,
    reason: string
  ): number
  getThrottle(key: string): AuthThrottleRecord | null
  putThrottle(record: AuthThrottleRecord): void
  deleteThrottle(key: string): boolean
  insertChallenge(record: AuthChallengeRecord): void
  getChallenge(id: string, scopeKey: string): AuthChallengeRecord | null
  putChallenge(record: AuthChallengeRecord): void
  deleteChallengesForScope(scopeKey: string): number
  countActiveChallenges(nowMs: number): number
  appendAudit(record: AuthAuditRecord): number
  cleanup(nowMs: number, throttleBeforeMs: number): AuthCleanupResult
}

export interface KernelTransaction {
  readonly auth: AuthRepository
  readonly conversation: ConversationRepository
  readonly draft: DraftRepository
  readonly jobIntake: JobIntakeRepository
  readonly job: JobRepository
}

export interface UnitOfWork {
  transaction<T>(work: (transaction: KernelTransaction) => T): T
}
