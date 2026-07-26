/**
 * Production facade over `src/server/control-plane`.
 *
 * External `src/**` code should import from this module (or `@server/legacy-shim`)
 * instead of deep `../control-plane/...` paths. Implementation lives in
 * `control-plane`; this barrel re-exports the public surface.
 */

export * from '../control-plane/types'
export * from '../control-plane/service'
export * from '../control-plane/controls'
export * from '../control-plane/draft-plan'
export * from '../control-plane/draft-references'
export * from '../control-plane/evidence/store'
export * from '../control-plane/evidence/hash'
export * from '../control-plane/evidence/normalize'
export * from '../control-plane/evidence/paths'
export * from '../control-plane/evidence/preflight'
export * from '../control-plane/execution-run-context'
export * from '../control-plane/executor'
export * from '../control-plane/job-queue'
export * from '../control-plane/job-reference-assets'
export * from '../control-plane/prompts'
export * from '../control-plane/queue-coordinator'
export * from '../control-plane/reconcile'
// reference-manifest re-exports overlapping path helpers; prefer it as the single surface.
export * from '../control-plane/reference-manifest'
export * from '../control-plane/shutdown-state'
export * from '../control-plane/task-attempts'
export * from '../control-plane/workload-slot'
export * from '../control-plane/workload-slot-store'
export * from '../control-plane/workspace-lease-context'
export * from '../control-plane/workspace-lease-store'
export * from '../control-plane/deletion-coordinator'
export * from '../control-plane/runtime-handle-cursor'
export * from '../control-plane/runtime-supervisor'
export * from '../control-plane/constants'
export * from '../control-plane/continue-failed-job'
export * from '../control-plane/plan-node-ref'
export * from '../control-plane/progress-sse'
export * from '../control-plane/execution-gate'
export * from '../control-plane/execution-infra-errors'
export * from '../control-plane/execution-queue-meta'
export * from '../control-plane/execution-recovery'
export * from '../control-plane/recovery-limits'
export * from '../control-plane/repair-tasks'
export * from '../control-plane/verification-attempts'
export * from '../control-plane/verification/types'
export * from '../control-plane/task-blocker/classify'
export * from '../control-plane/task-blocker/recovery'

// Unique reference-paths helpers only — overlapping names come from reference-manifest.
export {
  resolveManifestEntryAbsolutePath,
  attachmentIsolationDir
} from '../control-plane/reference-paths'

// Avoid `export *` collision with `service` (mapJob / getUserJob / getThreadJob /
// updateJobRow / updateJobRowForSnapshot).
export type { JobRowPatch } from '../control-plane/repository'
export {
  EXECUTION_OCCUPYING_STATUSES,
  EXECUTION_LEASE_TTL_SEC,
  executionLeaseOwner,
  bootIdFromLeaseOwner,
  isStaleExecutionLeaseOwner,
  clearStaleExecutionLeaseIfNeeded,
  findOccupyingJobId,
  findNextPendingJobId,
  findNextPendingJob,
  tryPromoteJobToRunning,
  hasLocalExecutionLease,
  acquireExecutionLease,
  refreshExecutionLease,
  clearExecutionLease,
  promoteContinuedPauseToPending,
  updateJobRowFenced,
  updateJobRowForSnapshotFenced,
  transitionJobStatus
} from '../control-plane/repository'

// Avoid `export *` collision on `registerRunRuntime` (also on runtime-supervisor).
export type {
  ExecutionRunOutcome,
  PlanningRunOutcome,
  ExecutionRunLifecycleDependencies,
  RunLifecycleConfig,
  RunLifecycleDependencies
} from '../control-plane/run-lifecycle'
export {
  stopRunLifecycle,
  scheduleStopRunLifecycle,
  closeAndReleaseWorkloadSlot,
  stopAndReleaseWorkloadSlot,
  finishExecutionRunLifecycle,
  finishPlanningRunLifecycle
} from '../control-plane/run-lifecycle'

// Avoid collision with recovery-limits re-exports of the same constants.
export type { VerifierInfraRecovery } from '../control-plane/verification-recovery'
export {
  isVerifierToolMissMessage,
  verifierInfraAttempt,
  withVerifierInfraAttempt,
  resolveVerifierInfraRecovery,
  resetVerifierInfraCounter
} from '../control-plane/verification-recovery'

// MCP handlers share an identical `McpDispatchResult` type name — export symbols only.
// TaskEvidencePacket is already exported via evidence/normalize.
export { handleTaskMcpJsonRpc } from '../control-plane/mcp/task-handler'
export type { TaskMcpSession } from '../control-plane/mcp/task-session'
export {
  authorizeTaskMcpRequest,
  registerTaskMcpSession,
  unregisterTaskMcpSession,
  getTaskMcpSession,
  buildTaskMcpCapabilityToken
} from '../control-plane/mcp/task-session'
export { handleSliceVerifierMcpJsonRpc } from '../control-plane/mcp/slice-handler'
export { authorizeSliceVerifierMcpRequest } from '../control-plane/mcp/slice-session'
export { handleMilestoneVerifierMcpJsonRpc } from '../control-plane/mcp/milestone-handler'
export { authorizeMilestoneVerifierMcpRequest } from '../control-plane/mcp/milestone-session'

// `mapJob` / `updateJobRow` are re-exported via `service` (which re-exports repository).
