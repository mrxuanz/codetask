/**
 * Canonical HTTP paths for the current Hono business lifecycle.
 *
 * Both the deterministic in-process lifecycle test and the standalone business
 * E2E client import this table. A Hono route migration therefore updates one
 * test contract instead of allowing the two acceptance layers to drift apart.
 */
export const HONO_BUSINESS_PHASES = [
  'conversation',
  'design',
  'planning',
  'execution',
  'verification',
  'evidence'
] as const

const segment = (value: string): string => encodeURIComponent(value)

export const HONO_BUSINESS_ROUTES = {
  projects: '/api/projects',
  projectConversations: (projectId: string) => `/api/projects/${segment(projectId)}/conversations`,
  conversationProviders: '/api/conversations/providers',
  conversation: (conversationId: string) => `/api/conversations/${segment(conversationId)}`,
  conversationProvider: (conversationId: string) =>
    `/api/conversations/${segment(conversationId)}/provider`,
  conversationMessages: (conversationId: string) =>
    `/api/conversations/${segment(conversationId)}/messages`,
  conversationAttachments: (conversationId: string) =>
    `/api/conversations/${segment(conversationId)}/attachments`,
  conversationAttachment: (conversationId: string, attachmentId: string) =>
    `/api/conversations/${segment(conversationId)}/attachments/${segment(attachmentId)}`,
  conversationTurns: (conversationId: string) =>
    `/api/conversations/${segment(conversationId)}/turns`,
  conversationTurn: (conversationId: string, turnId: string) =>
    `/api/conversations/${segment(conversationId)}/turns/${segment(turnId)}`,
  conversationTurnCancel: (conversationId: string, turnId: string) =>
    `/api/conversations/${segment(conversationId)}/turns/${segment(turnId)}/cancel`,
  drafts: '/api/drafts',
  draft: (draftId: string) => `/api/drafts/${segment(draftId)}`,
  draftAbilities: (draftId: string) => `/api/drafts/${segment(draftId)}/abilities`,
  draftExecutionProfile: (draftId: string) => `/api/drafts/${segment(draftId)}/execution-profile`,
  draftConfirm: (draftId: string) => `/api/drafts/${segment(draftId)}/confirm`,
  draftPlanningSession: (draftId: string) => `/api/drafts/${segment(draftId)}/planning-session`,
  planningSession: (sessionId: string) => `/api/planning-sessions/${segment(sessionId)}`,
  planningTreeConfirm: (sessionId: string) =>
    `/api/planning-sessions/${segment(sessionId)}/tree/confirm`,
  planningPublish: (sessionId: string) => `/api/planning-sessions/${segment(sessionId)}/publish`,
  jobs: (query = '') => `/api/jobs${query ? `?${query}` : ''}`,
  job: (jobId: string) => `/api/jobs/${segment(jobId)}`,
  jobTree: (jobId: string) => `/api/jobs/${segment(jobId)}/tree`,
  jobEvidence: (jobId: string, workId: string) =>
    `/api/jobs/${segment(jobId)}/work/${segment(workId)}/evidence`,
  jobVerifications: (jobId: string) => `/api/jobs/${segment(jobId)}/verifications`
} as const
