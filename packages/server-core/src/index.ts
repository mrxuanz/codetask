/**
 * Host bootstrap stays in src/server during 01; apps import createHonoApp + design from this package.
 */
export { createHonoApp, type CreateHonoAppOptions } from './create-app.ts'
export {
  composeDesignModule,
  registeredPlanToExecutionTree,
  authorizePlannerMcpRequest,
  handlePlannerMcpJsonRpc,
  initPlannerMcpBackend,
  getPlannerMcpBackendPort,
  buildPlannerSystemPrompt,
  type DesignModule,
  type DesignModuleDeps,
  type Actor
} from './modules/design/index.ts'
export {
  composeExecutionModule,
  type ExecutionModule,
  FakeAgentRuntime,
  ScriptedAgentRuntime,
  authorizeTaskMcpRequest,
  handleTaskMcpJsonRpc,
  initExecutionMcpBackend,
  getExecutionMcpBackendPort,
  registerTaskMcpSession,
  unregisterTaskMcpSession,
  tryBuildTaskWorkerMcpUrl,
  buildTaskWorkerMcpUrl,
  buildTaskMcpCapabilityToken,
  handleSliceVerifierMcpJsonRpc,
  handleMilestoneVerifierMcpJsonRpc,
  authorizeSliceVerifierMcpRequest,
  authorizeMilestoneVerifierMcpRequest
} from './modules/execution/index.ts'
export {
  composeConversationModule,
  type ConversationModule,
  type ConversationModuleDeps,
  ConversationApplication,
  ConversationForbiddenError,
  ConversationNotFoundError
} from './modules/conversation/index.ts'
export {
  composeAuthModule,
  AuthApplication,
  AuthError,
  principalToActor,
  toModuleActor,
  type AuthModule,
  type AuthModuleDeps,
  type AuthPrincipal,
  type SessionIssue,
  type BootstrapData,
  type LoginOptions,
  type CaptchaChallenge
} from './modules/auth/index.ts'
/** Auth Actor (userId + username + session). Design Actor remains the slim module port. */
export type { Actor as AuthActor } from './modules/auth/domain/actor.ts'
export {
  composeSettingsModule,
  SettingsApplication,
  SettingsError,
  type SettingsModule,
  type SettingsModuleDeps
} from './modules/settings/index.ts'
export {
  composeRealtimeModule,
  openRealtimeStream,
  RealtimeDispatcher,
  RealtimeEventLog,
  LiveFanout,
  type RealtimeModule
} from './modules/realtime/index.ts'
