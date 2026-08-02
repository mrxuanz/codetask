import type { PublicApiClient } from './client'
import { TIMEOUTS } from '../config/timeouts'

/** Map host CLI codes ↔ canonical Conversation provider codes (architecture 03). */
export function toCanonicalProviderCode(coreCode: string): string {
  const value = coreCode.trim().toLowerCase()
  if (value === 'claude-code' || value === 'claude' || value === 'claudecode') return 'claude'
  if (value === 'cursorcli' || value === 'cursor' || value === 'cursor-cli' || value === 'cursor-agent') {
    return 'cursor'
  }
  return value
}

export function toHostCoreCode(providerCode: string): string {
  const value = providerCode.trim().toLowerCase()
  if (value === 'claude') return 'claude-code'
  if (value === 'cursor') return 'cursorcli'
  return value
}

function architecture03Removed(surface: string): never {
  throw new Error(
    `architecture_03_removed:${surface}:use_/api/drafts_/api/planning-sessions_/api/jobs_/api/conversations`
  )
}

/** Public job routes wrap payloads as `{ job: ... }`. */
function unwrapJob(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null
  const obj = data as Record<string, unknown>
  if (obj.job && typeof obj.job === 'object') {
    return obj.job as Record<string, unknown>
  }
  if (typeof obj.id === 'string' || typeof obj.jobId === 'string') {
    return obj
  }
  return null
}

export async function setupAccount(
  client: PublicApiClient,
  input: { username: string; password: string; setupToken: string }
): Promise<{ token: string; username: string }> {
  const result = await client.request<{
    token?: string
    actor?: { username: string }
    username?: string
  }>('POST', '/api/auth/setup', input, { operationId: 'auth.setup', auth: false })
  if (result.status >= 400 || !result.data?.token) {
    throw new Error(`auth.setup_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return {
    token: result.data.token,
    username: result.data.actor?.username ?? result.data.username ?? input.username
  }
}

export async function login(
  client: PublicApiClient,
  input: { username: string; password: string }
): Promise<{ token: string; username: string }> {
  const result = await client.request<{
    token?: string
    actor?: { username: string }
    username?: string
  }>('POST', '/api/auth/login', input, { operationId: 'auth.login', auth: false })
  if (result.status >= 400 || !result.data?.token) {
    throw new Error(`auth.login_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return {
    token: result.data.token,
    username: result.data.actor?.username ?? result.data.username ?? input.username
  }
}

export async function logout(client: PublicApiClient): Promise<void> {
  await client.request('POST', '/api/auth/logout', undefined, { operationId: 'auth.logout' })
}

export async function createProject(
  client: PublicApiClient,
  input: { workspaceRoot: string; title?: string }
): Promise<{ id: string; workspaceRoot: string }> {
  const result = await client.request<{ id: string; workspaceRoot: string }>(
    'POST',
    '/api/projects',
    { ...input, createIfMissing: true },
    { operationId: 'project.create' }
  )
  if (result.status >= 400 || !result.data?.id) {
    throw new Error(`project.create_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

/**
 * Create an ordinary Chat conversation (architecture 03).
 * `threadKind: create_task` is rejected — Design owns drafts via /api/drafts.
 * Returns both `coreCode` (host alias) and `providerCode` (canonical) for oracles.
 */
export async function createThread(
  client: PublicApiClient,
  projectId: string,
  input: { title?: string; coreCode: string; threadKind?: string }
): Promise<{ id: string; coreCode?: string; providerCode?: string; threadKind?: string }> {
  if (input.threadKind === 'create_task' || input.threadKind === 'task_snapshot') {
    architecture03Removed('create_task_thread')
  }
  const providerCode = toCanonicalProviderCode(input.coreCode)
  const result = await client.request<{ id: string; providerCode?: string }>(
    'POST',
    `/api/projects/${projectId}/conversations`,
    {
      title: input.title ?? 'Business E2E Chat',
      providerCode
    },
    { operationId: 'conversation.create' }
  )
  if (result.status >= 400 || !result.data?.id) {
    throw new Error(`conversation.create_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  const code = result.data.providerCode ?? providerCode
  return {
    id: result.data.id,
    providerCode: code,
    coreCode: toHostCoreCode(code),
    threadKind: 'chat'
  }
}

export async function getThread(
  client: PublicApiClient,
  threadId: string
): Promise<Record<string, unknown>> {
  const result = await client.request<Record<string, unknown>>(
    'GET',
    `/api/conversations/${threadId}`,
    undefined,
    { operationId: 'conversation.get' }
  )
  const data = (result.data ?? {}) as Record<string, unknown>
  const providerCode = String(data.providerCode ?? data.coreCode ?? '')
  return {
    ...data,
    providerCode,
    coreCode: toHostCoreCode(providerCode),
    threadKind: 'chat'
  }
}

export async function listCores(client: PublicApiClient): Promise<unknown> {
  const result = await client.request('GET', '/api/conversations/providers', undefined, {
    operationId: 'providers.list'
  })
  return result.data
}

export async function startTurn(
  client: PublicApiClient,
  threadId: string,
  message: string,
  options: { createTaskMode?: boolean; kind?: string; attachmentIds?: string[] } = {}
): Promise<{ turnId: string }> {
  if (
    options.createTaskMode === true ||
    options.kind === 'create_task' ||
    options.kind === 'draft'
  ) {
    architecture03Removed('create_task_turn')
  }
  const body: Record<string, unknown> = {
    message,
    attachmentIds: options.attachmentIds ?? [],
    idempotencyKey: `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
  const result = await client.request<{ turnId: string }>(
    'POST',
    `/api/conversations/${threadId}/turns`,
    body,
    { operationId: 'conversation.start_turn' }
  )
  if (result.status >= 400 || !result.data?.turnId) {
    throw new Error(`turn.start_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function getTurn(
  client: PublicApiClient,
  threadId: string,
  turnId: string
): Promise<{ turn: Record<string, unknown> }> {
  const result = await client.request<Record<string, unknown>>(
    'GET',
    `/api/conversations/${threadId}/turns/${turnId}`,
    undefined,
    { operationId: 'conversation.get_turn' }
  )
  if (result.status >= 400) {
    throw new Error(`turn.get_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  const data = (result.data ?? {}) as Record<string, unknown>
  const turn =
    data.turn && typeof data.turn === 'object'
      ? (data.turn as Record<string, unknown>)
      : data
  return { turn }
}

/**
 * Poll until CodeTask marks the turn terminal (completed|failed|cancelled).
 * Omit timeoutMs (or pass <=0) to wait for the business API forever.
 * Pass a positive timeoutMs only for intentional short negative probes.
 */
export async function waitTurnTerminal(
  client: PublicApiClient,
  threadId: string,
  turnId: string,
  timeoutMs?: number
): Promise<Record<string, unknown>> {
  return pollTerminal(
    async () => (await getTurn(client, threadId, turnId)).turn,
    `turn_${turnId}`,
    timeoutMs
  )
}

export async function listMessages(
  client: PublicApiClient,
  threadId: string
): Promise<Array<Record<string, unknown>>> {
  const result = await client.request<
    Array<Record<string, unknown>> | { messages?: Array<Record<string, unknown>> }
  >('GET', `/api/conversations/${threadId}/messages`, undefined, {
    operationId: 'conversation.list_messages'
  })
  const data = result.data
  if (Array.isArray(data)) return data
  return data?.messages ?? []
}

export async function cancelTurn(
  client: PublicApiClient,
  threadId: string,
  turnId: string
): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/conversations/${threadId}/turns/${turnId}/cancel`,
    undefined,
    { operationId: 'conversation.cancel_turn' }
  )
  return result.data
}

/** Design module — create a draft (replaces create_task collecting draft). */
export async function createDesignDraft(
  client: PublicApiClient,
  input: {
    projectId: string
    title: string
    summary?: string
    requirementsMarkdown?: string
  }
): Promise<Record<string, unknown>> {
  const result = await client.request<Record<string, unknown>>('POST', '/api/drafts', input, {
    operationId: 'draft.create'
  })
  if (result.status >= 400 || !result.data) {
    throw new Error(`draft.create_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function listDesignDrafts(client: PublicApiClient): Promise<unknown> {
  const result = await client.request('GET', '/api/drafts', undefined, {
    operationId: 'draft.list'
  })
  if (result.status >= 400) {
    throw new Error(`draft.list_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function getDesignDraft(
  client: PublicApiClient,
  draftId: string
): Promise<Record<string, unknown>> {
  const result = await client.request<Record<string, unknown>>(
    'GET',
    `/api/drafts/${draftId}`,
    undefined,
    { operationId: 'draft.get' }
  )
  if (result.status >= 400 || !result.data) {
    throw new Error(`draft.get_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function patchDesignDraftAbilities(
  client: PublicApiClient,
  draftId: string,
  expectedRevision: number,
  abilities: Array<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const result = await client.request<Record<string, unknown>>(
    'PATCH',
    `/api/drafts/${draftId}/abilities`,
    { expectedRevision, abilities },
    { operationId: 'draft.patch_abilities' }
  )
  if (result.status >= 400 || !result.data) {
    throw new Error(`draft.abilities_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function patchDesignExecutionProfile(
  client: PublicApiClient,
  draftId: string,
  expectedRevision: number,
  executionProfile: {
    plannerCoreCode: string
    sliceVerifierCoreCode: string
    milestoneVerifierCoreCode: string
  }
): Promise<Record<string, unknown>> {
  const result = await client.request<Record<string, unknown>>(
    'PATCH',
    `/api/drafts/${draftId}/execution-profile`,
    { expectedRevision, executionProfile },
    { operationId: 'draft.patch_execution_profile' }
  )
  if (result.status >= 400 || !result.data) {
    throw new Error(`draft.execution_profile_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function confirmDesignDraft(
  client: PublicApiClient,
  draftId: string,
  expectedRevision: number
): Promise<Record<string, unknown>> {
  const result = await client.request<Record<string, unknown>>(
    'POST',
    `/api/drafts/${draftId}/confirm`,
    { expectedRevision },
    { operationId: 'draft.confirm' }
  )
  if (result.status >= 400 || !result.data) {
    throw new Error(`draft.confirm_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function createDesignPlanningSession(
  client: PublicApiClient,
  draftId: string,
  expectedRevision: number
): Promise<Record<string, unknown>> {
  const result = await client.request<Record<string, unknown>>(
    'POST',
    `/api/drafts/${draftId}/planning-session`,
    { expectedRevision },
    { operationId: 'draft.planning_session' }
  )
  if (result.status >= 400 || !result.data) {
    throw new Error(`draft.planning_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function listThreadDrafts(
  client: PublicApiClient,
  _threadId: string
): Promise<unknown> {
  // Thread-scoped drafts removed — return Design draft list for soft probes.
  return listDesignDrafts(client)
}

export async function confirmDraft(
  _client: PublicApiClient,
  _threadId: string,
  _messageId: string
): Promise<unknown> {
  architecture03Removed('thread_draft_confirm')
}

export async function confirmDraftFinal(
  _client: PublicApiClient,
  _threadId: string,
  _messageId: string
): Promise<unknown> {
  architecture03Removed('thread_draft_confirm_final')
}

export async function getLatestJob(
  _client: PublicApiClient,
  _threadId: string
): Promise<Record<string, unknown> | null> {
  architecture03Removed('thread_job_latest')
}

export async function listThreadPlans(
  _client: PublicApiClient,
  _threadId: string
): Promise<Array<Record<string, unknown>>> {
  architecture03Removed('thread_plans')
}

export async function getJob(
  client: PublicApiClient,
  _threadId: string,
  jobId: string
): Promise<Record<string, unknown>> {
  const result = await client.request<Record<string, unknown>>(
    'GET',
    `/api/jobs/${jobId}`,
    undefined,
    { operationId: 'job.get' }
  )
  if (result.status >= 400) {
    throw new Error(`job.get_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  const job = unwrapJob(result.data)
  if (!job) throw new Error(`job.get_empty:${jobId}`)
  return job
}

export async function confirmPlan(
  _client: PublicApiClient,
  _threadId: string,
  _jobId: string
): Promise<unknown> {
  architecture03Removed('thread_plan_confirm')
}

export async function confirmPlanNode(
  _client: PublicApiClient,
  _threadId: string,
  _jobId: string,
  _nodeRef: string
): Promise<unknown> {
  architecture03Removed('thread_plan_node_confirm')
}

export async function createJob(
  _client: PublicApiClient,
  _threadId: string,
  _body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  architecture03Removed('thread_job_create')
}

export async function getTaskEvidence(
  client: PublicApiClient,
  _threadId: string,
  jobId: string,
  taskId: string
): Promise<unknown> {
  const result = await client.request(
    'GET',
    `/api/jobs/${jobId}/work/${encodeURIComponent(taskId)}/evidence`,
    undefined,
    { operationId: 'job.task_evidence' }
  )
  if (result.status >= 400) {
    throw new Error(`job.evidence_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

/**
 * Poll until CodeTask marks the job terminal (completed|failed|cancelled).
 * Omit timeoutMs (or pass <=0) to wait for the business API forever.
 * Pass a positive timeoutMs only for intentional short negative probes.
 */
export async function waitJobTerminal(
  client: PublicApiClient,
  threadId: string,
  jobId: string,
  timeoutMs?: number
): Promise<Record<string, unknown>> {
  return pollTerminal(() => getJob(client, threadId, jobId), `job_${jobId}`, timeoutMs)
}

async function pollTerminal(
  load: () => Promise<Record<string, unknown>>,
  label: string,
  timeoutMs?: number
): Promise<Record<string, unknown>> {
  const hasDeadline = typeof timeoutMs === 'number' && timeoutMs > 0
  const deadline = hasDeadline ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY
  let lastTransientError: unknown
  for (;;) {
    try {
      const entity = await load()
      const status = String(entity.status ?? '')
      if (['completed', 'failed', 'cancelled', 'succeeded'].includes(status)) return entity
      lastTransientError = undefined
    } catch (error) {
      if (!isTransientPollError(error)) throw error
      lastTransientError = error
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timeout:${label}${lastTransientError ? `:${formatPollError(lastTransientError)}` : ''}`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.turnPollMs))
  }
}

function isTransientPollError(error: unknown): boolean {
  const text = formatPollError(error).toLowerCase()
  return /fetch failed|econnreset|econnrefused|etimedout|socket|network|aborterror/.test(text)
}

function formatPollError(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error
        ? `:${error.cause.name}:${error.cause.message}`
        : error.cause
          ? `:${String(error.cause)}`
          : ''
    return `${error.name}:${error.message}${cause}`
  }
  return String(error)
}

export async function updateDraft(
  _client: PublicApiClient,
  _threadId: string,
  _messageId: string,
  _patch: Record<string, unknown>
): Promise<unknown> {
  architecture03Removed('thread_draft_update')
}

export async function unlockDraft(
  _client: PublicApiClient,
  _threadId: string,
  _messageId: string
): Promise<unknown> {
  architecture03Removed('thread_draft_unlock')
}

export async function unlockDraftContract(
  _client: PublicApiClient,
  _threadId: string,
  _messageId: string
): Promise<unknown> {
  architecture03Removed('thread_draft_unlock_contract')
}

export async function confirmDraftSection(
  _client: PublicApiClient,
  _threadId: string,
  _messageId: string,
  _section: string
): Promise<unknown> {
  architecture03Removed('thread_draft_section_confirm')
}

export async function updateDraftAbilities(
  _client: PublicApiClient,
  _threadId: string,
  _messageId: string,
  _selections: Array<{ abilityCode: string; coreCode: string }>
): Promise<unknown> {
  architecture03Removed('thread_draft_abilities')
}

export async function updateDraftExecutionConfig(
  _client: PublicApiClient,
  _threadId: string,
  _messageId: string,
  _config: {
    plannerCoreCode: string
    sliceVerifierCoreCode: string
    milestoneVerifierCoreCode: string
  }
): Promise<unknown> {
  architecture03Removed('thread_draft_execution_config')
}

export async function uploadThreadAttachment(
  client: PublicApiClient,
  threadId: string,
  filePath: string,
  fileName: string
): Promise<unknown> {
  const { readFileSync } = await import('node:fs')
  const bytes = readFileSync(filePath)
  const form = new FormData()
  form.append('file', new Blob([bytes]), fileName)
  const result = await client.uploadMultipart(
    `/api/conversations/${threadId}/attachments`,
    form,
    {
      operationId: 'attachment.upload'
    }
  )
  if (result.status >= 400) {
    throw new Error(`attachment.upload_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function downloadThreadAttachment(
  client: PublicApiClient,
  threadId: string,
  attachmentId: string
): Promise<Buffer> {
  const result = await client.requestBinary(
    'GET',
    `/api/conversations/${threadId}/attachments/${encodeURIComponent(attachmentId)}`,
    { operationId: 'attachment.download' }
  )
  if (result.status >= 400) {
    throw new Error(`attachment.download_failed:${result.status}`)
  }
  return result.body
}

export async function updateDraftReferenceDescription(
  _client: PublicApiClient,
  _threadId: string,
  _messageId: string,
  _referenceId: string,
  _description: string
): Promise<unknown> {
  architecture03Removed('thread_draft_reference_description')
}

export async function importDraftReferences(
  _client: PublicApiClient,
  _threadId: string,
  _messageId: string,
  _attachmentIds: string[],
  _descriptions: Record<string, string> = {}
): Promise<unknown> {
  architecture03Removed('thread_draft_reference_import')
}

export async function addLocalCorpusDraftReference(
  _client: PublicApiClient,
  _threadId: string,
  _messageId: string,
  _input: {
    localPath: string
    name: string
    description: string
    kind?: 'file' | 'directory'
  }
): Promise<unknown> {
  architecture03Removed('thread_draft_local_corpus')
}

export async function putAgentDefaults(
  client: PublicApiClient,
  input: {
    plannerProvider: string
    sliceVerifierProvider: string
    milestoneVerifierProvider: string
  }
): Promise<unknown> {
  const current = await getAgentDefaults(client)
  const revision =
    typeof current === 'object' &&
    current !== null &&
    'revision' in current &&
    typeof (current as { revision: unknown }).revision === 'number'
      ? (current as { revision: number }).revision
      : 0
  const result = await client.request(
    'PUT',
    '/api/settings/agent-defaults',
    { ...input, expectedRevision: revision },
    { operationId: 'settings.agent_defaults.put' }
  )
  if (result.status >= 400) {
    throw new Error(`settings.agent_defaults_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

/** @deprecated Use {@link putAgentDefaults} */
export async function putControlPlanePolicies(
  client: PublicApiClient,
  input: {
    plannerCoreCode: string
    sliceVerifierCoreCode: string
    milestoneVerifierCoreCode: string
  }
): Promise<unknown> {
  return putAgentDefaults(client, {
    plannerProvider: input.plannerCoreCode,
    sliceVerifierProvider: input.sliceVerifierCoreCode,
    milestoneVerifierProvider: input.milestoneVerifierCoreCode
  })
}

export async function getAgentDefaults(client: PublicApiClient): Promise<unknown> {
  const result = await client.request('GET', '/api/settings/agent-defaults', undefined, {
    operationId: 'settings.agent_defaults.get'
  })
  if (result.status >= 400) {
    throw new Error(
      `settings.agent_defaults_get_failed:${result.status}:${result.raw.message ?? ''}`
    )
  }
  return result.data
}

/** @deprecated Use {@link getAgentDefaults} */
export async function getControlPlanePolicies(client: PublicApiClient): Promise<unknown> {
  return getAgentDefaults(client)
}

export async function getMcpSettings(client: PublicApiClient): Promise<{
  settings: unknown
  constraints?: unknown
}> {
  const result = await client.request<{ settings: unknown; constraints?: unknown }>(
    'GET',
    '/api/settings/mcp',
    undefined,
    { operationId: 'settings.mcp.get' }
  )
  if (result.status >= 400) {
    throw new Error(`settings.mcp_get_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data ?? { settings: {} }
}

export async function putMcpSettings(
  client: PublicApiClient,
  settings: unknown,
  expectedRevision = 0
): Promise<{ settings: unknown }> {
  const result = await client.request<{ settings: unknown }>(
    'PUT',
    '/api/settings/mcp',
    { settings, expectedRevision },
    { operationId: 'settings.mcp.put' }
  )
  if (result.status >= 400) {
    throw new Error(`settings.mcp_put_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data ?? { settings }
}

/** Soft probe helper: returns status without throwing. */
export async function softRequest(
  client: PublicApiClient,
  method: string,
  path: string,
  body?: unknown,
  operationId?: string
): Promise<{ status: number; data: unknown; message?: string }> {
  const result = await client.request(method, path, body, {
    operationId: operationId ?? `soft.${method}.${path}`
  })
  return { status: result.status, data: result.data, message: result.raw.message }
}

export async function pauseJob(client: PublicApiClient, jobId: string): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/jobs/${jobId}/pause`,
    {},
    {
      operationId: 'job.pause'
    }
  )
  if (result.status >= 400) {
    throw new Error(`job.pause_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function resumeJob(client: PublicApiClient, jobId: string): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/jobs/${jobId}/resume`,
    {},
    {
      operationId: 'job.resume'
    }
  )
  if (result.status >= 400) {
    throw new Error(`job.resume_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function continueJob(client: PublicApiClient, jobId: string): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/jobs/${jobId}/continue`,
    {},
    {
      operationId: 'job.continue'
    }
  )
  if (result.status >= 400) {
    throw new Error(`job.continue_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function cancelJob(client: PublicApiClient, jobId: string): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/jobs/${jobId}/cancel`,
    {},
    {
      operationId: 'job.cancel'
    }
  )
  if (result.status >= 400) {
    throw new Error(`job.cancel_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function restartJob(client: PublicApiClient, jobId: string): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/jobs/${jobId}/restart`,
    {},
    {
      operationId: 'job.restart'
    }
  )
  if (result.status >= 400) {
    throw new Error(`job.restart_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}
