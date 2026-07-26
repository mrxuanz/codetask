export {
  handleRoute,
  assertAuthBoundary,
  parseSchema,
  readIdempotencyKey,
  requireIdempotencyKey,
  mapErrorCodeToHttp,
  mapApplicationError,
  mapThrownRouteError,
  mapCommandResult,
  apiStatus,
  RouteAuthError,
  RouteSchemaError,
  type HttpRequest,
  type HttpResult,
  type HttpSuccess,
  type HttpFailure,
  type AuthContext,
  type ApiStatusCode
} from './route-handler'

export { createConversationRoutes, type ConversationRouteDeps } from './routes/conversation'
export { createDraftRoutes, type DraftRouteDeps } from './routes/drafts'
export { createPlanRoutes, type PlanRouteDeps } from './routes/plans'
export { createJobRoutes, type JobRouteDeps } from './routes/jobs'
export {
  mountCoreHttpRoutes,
  toHttpRequest,
  sendHttpResult,
  type HttpServerDeps as CoreHttpMountDeps
} from './hono-mount'
