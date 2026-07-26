/**
 * Core domain barrel — pure aggregates only (no SQLite / HTTP / providers).
 *
 * Explicit named re-exports (tsx does not surface `export *` from these barrels).
 * Thread aggregate lives under conversation/ (重构.md §4.2).
 */

export { DomainError, type DomainResult } from './shared/errors.ts'

export type {
  Draft,
  DraftId,
  DraftPayload,
  DraftSectionPayload,
  DraftStatus
} from './drafts/index.ts'
export {
  DRAFT_STATUSES,
  DraftDomainError,
  abandonDraft,
  asDraftId,
  assertDraftEditable,
  confirmDraft,
  confirmDraftSection,
  createDraft,
  unlockDraft,
  updateCollectingContent,
  updateCollectingPayload
} from './drafts/index.ts'

export type {
  Plan,
  PlanEdge,
  PlanId,
  PlanNode,
  PlanNodeId,
  PlanNodeKind,
  PlanNodePatch,
  PlanOperation,
  PlanRevision,
  PlanStatus
} from './plans/index.ts'
export {
  PlanDomainError,
  applyOperation,
  asPlanId,
  asPlanNodeId,
  asPlanRevision,
  assertAcyclic,
  confirmPlan,
  detectCycle,
  markInReview,
  planError,
  validatePlan
} from './plans/index.ts'

export type { Job, JobErrorCode, JobId, JobStatus } from './jobs/index.ts'
export {
  JobCommandService,
  JobDomainError,
  asJobId,
  createJob,
  illegalJobTransition
} from './jobs/index.ts'

export type {
  AttemptId,
  AttemptStatus,
  Task,
  TaskAttempt,
  TaskErrorCode,
  TaskId
} from './tasks/index.ts'
export {
  TERMINAL_ATTEMPT_STATUSES,
  TaskDomainError,
  asAttemptId,
  asTaskId,
  createTask,
  createTaskAttempt,
  failAttempt,
  illegalAttemptTransition,
  isTaskReady,
  markInconclusive,
  startAttempt,
  succeedAttempt
} from './tasks/index.ts'

export type {
  FindingSeverity,
  JobCompletionDecision,
  VerificationAttempt,
  VerificationAttemptId,
  VerificationAttemptStatus,
  VerificationFinding,
  VerificationResult,
  VerificationScope,
  VerificationTransition,
  VerificationVerdict
} from './verification/index.ts'
export {
  VERIFICATION_VERDICTS,
  VerificationDomainError,
  asVerificationAttemptId,
  assertNotForgingCompleted,
  canForgeJobCompleted,
  completeVerification,
  decideJobCompletion,
  remapVerdict,
  startVerification,
  verificationError
} from './verification/index.ts'

export type {
  ArtifactRetentionKind,
  RetainedArtifact,
  RetentionPolicy
} from './retention/index.ts'
export {
  DEFAULT_RETENTION_POLICY,
  computeExpiryMs,
  isExpiredArtifactEligible,
  selectEligibleArtifacts,
  ttlMsForKind
} from './retention/index.ts'

export type { ProjectId, Thread, ThreadId, ThreadPointers, UserId } from './conversation/index.ts'
export {
  asProjectId,
  asThreadId,
  asUserId,
  createThread,
  withThreadPointers
} from './conversation/index.ts'
