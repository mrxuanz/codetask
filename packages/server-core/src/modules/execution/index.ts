export { composeExecutionModule, type ExecutionModule } from './composition.ts'
export {
  ExecutionConflictError,
  ExecutionForbiddenError,
  ExecutionNotFoundError,
  ExecutionValidationError,
  type Actor
} from './shared.ts'
export { FakeAgentRuntime, UnsupportedAgentRuntime, ScriptedAgentRuntime } from './composition.ts'
export {
  initExecutionMcpBackend,
  getExecutionMcpBackendPort,
  handleSliceVerifierMcpJsonRpc,
  handleMilestoneVerifierMcpJsonRpc,
  authorizeSliceVerifierMcpRequest,
  authorizeMilestoneVerifierMcpRequest
} from './verification/mcp/index.ts'
export { createSubmitJobService } from './job/application/submit-job.ts'
export { decideNextStep, type CoordinatorDecision } from './work/application/coordinator.ts'
export { allowedJobActions } from './job/domain/job-actions.ts'
export {
  computeReadyWork,
  computeSliceReadyForVerification,
  computeMilestoneReadyForVerification,
  computeJobCompletion,
  computeDeadlock
} from './work/domain/readiness.ts'
export {
  registerTaskMcpSession,
  unregisterTaskMcpSession,
  getTaskMcpSession,
  buildTaskMcpCapabilityToken,
  authorizeTaskMcpRequest,
  type TaskMcpSession
} from './work/mcp/task-session.ts'
export { handleTaskMcpJsonRpc, type McpDispatchResult } from './work/mcp/task-handler.ts'
export { taskMcpToolDefinitions, allTaskMcpToolNames } from './work/mcp/task-tools.ts'
export { buildTaskWorkerMcpUrl, tryBuildTaskWorkerMcpUrl } from './work/mcp/task-url.ts'
export { handleReportTaskResult, parseTaskResultToolArgs } from './work/mcp/task-result-tool.ts'
export { TASK_EVIDENCE_GRACE_MS } from './work/application/execute-work.ts'
