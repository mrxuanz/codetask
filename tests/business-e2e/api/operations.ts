import type { PublicApiClient } from './client'
import { TIMEOUTS } from '../config/timeouts'

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
  const result = await client.request<{ token: string; username: string }>(
    'POST',
    '/api/setup',
    input,
    { operationId: 'auth.setup', auth: false }
  )
  if (result.status >= 400 || !result.data?.token) {
    throw new Error(`auth.setup_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function login(
  client: PublicApiClient,
  input: { username: string; password: string }
): Promise<{ token: string; username: string }> {
  const result = await client.request<{ token: string; username: string }>(
    'POST',
    '/api/login',
    input,
    { operationId: 'auth.login', auth: false }
  )
  if (result.status >= 400 || !result.data?.token) {
    throw new Error(`auth.login_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function logout(client: PublicApiClient): Promise<void> {
  await client.request('POST', '/api/logout', undefined, { operationId: 'auth.logout' })
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

export async function createThread(
  client: PublicApiClient,
  projectId: string,
  input: { title?: string; coreCode?: string; threadKind?: string } = {}
): Promise<{ id: string; coreCode?: string }> {
  const result = await client.request<{ id: string; coreCode?: string }>(
    'POST',
    `/api/projects/${projectId}/threads`,
    {
      title: input.title ?? 'Business E2E Chat',
      coreCode: input.coreCode ?? 'opencode',
      threadKind: input.threadKind ?? 'chat'
    },
    { operationId: 'thread.create' }
  )
  if (result.status >= 400 || !result.data?.id) {
    throw new Error(`thread.create_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function getThread(
  client: PublicApiClient,
  threadId: string
): Promise<Record<string, unknown>> {
  const result = await client.request<Record<string, unknown>>(
    'GET',
    `/api/threads/${threadId}`,
    undefined,
    { operationId: 'thread.get' }
  )
  return (result.data ?? {}) as Record<string, unknown>
}

export async function listCores(client: PublicApiClient): Promise<unknown> {
  const result = await client.request('GET', '/api/agent/cores', undefined, {
    operationId: 'cores.list'
  })
  return result.data
}

export async function startTurn(
  client: PublicApiClient,
  threadId: string,
  message: string,
  options: { createTaskMode?: boolean; kind?: string } = {}
): Promise<{ turnId: string }> {
  const body: Record<string, unknown> = { message }
  if (options.createTaskMode === true) body.createTaskMode = true
  if (typeof options.kind === 'string') body.kind = options.kind
  const result = await client.request<{ turnId: string }>(
    'POST',
    `/api/threads/${threadId}/turns`,
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
  const result = await client.request<{ turn: Record<string, unknown> }>(
    'GET',
    `/api/threads/${threadId}/turns/${turnId}`,
    undefined,
    { operationId: 'conversation.get_turn' }
  )
  return { turn: (result.data?.turn ?? {}) as Record<string, unknown> }
}

export async function waitTurnTerminal(
  client: PublicApiClient,
  threadId: string,
  turnId: string,
  timeoutMs = TIMEOUTS.agentTurnMs
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { turn } = await getTurn(client, threadId, turnId)
    const status = String(turn.status ?? '')
    if (['completed', 'failed', 'cancelled'].includes(status)) return turn
    await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.turnPollMs))
  }
  throw new Error(`timeout:turn_${turnId}`)
}

export async function listMessages(
  client: PublicApiClient,
  threadId: string
): Promise<Array<Record<string, unknown>>> {
  const result = await client.request<{ messages?: Array<Record<string, unknown>> }>(
    'GET',
    `/api/threads/${threadId}/messages?limit=100`,
    undefined,
    { operationId: 'conversation.list_messages' }
  )
  return result.data?.messages ?? []
}

export async function cancelTurn(
  client: PublicApiClient,
  threadId: string,
  turnId: string
): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/threads/${threadId}/turns/${turnId}/cancel`,
    undefined,
    { operationId: 'conversation.cancel_turn' }
  )
  return result.data
}

export async function listThreadDrafts(
  client: PublicApiClient,
  threadId: string
): Promise<unknown> {
  const result = await client.request('GET', `/api/threads/${threadId}/drafts`, undefined, {
    operationId: 'draft.list_thread'
  })
  if (result.status >= 400) {
    throw new Error(`draft.list_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function confirmDraft(
  client: PublicApiClient,
  threadId: string,
  messageId: string
): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/threads/${threadId}/messages/${messageId}/draft/confirm`,
    {},
    { operationId: 'draft.confirm' }
  )
  if (result.status >= 400) {
    throw new Error(`draft.confirm_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function confirmDraftFinal(
  client: PublicApiClient,
  threadId: string,
  messageId: string
): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/threads/${threadId}/messages/${messageId}/draft/confirm-final`,
    {},
    { operationId: 'draft.confirm_final' }
  )
  if (result.status >= 400) {
    throw new Error(`draft.confirm_final_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function getLatestJob(
  client: PublicApiClient,
  threadId: string
): Promise<Record<string, unknown> | null> {
  const result = await client.request('GET', `/api/threads/${threadId}/jobs/latest`, undefined, {
    operationId: 'job.latest'
  })
  if (result.status >= 400) {
    throw new Error(`job.latest_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return unwrapJob(result.data)
}

export async function getJob(
  client: PublicApiClient,
  threadId: string,
  jobId: string
): Promise<Record<string, unknown>> {
  const result = await client.request<Record<string, unknown>>(
    'GET',
    `/api/threads/${threadId}/jobs/${jobId}`,
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
  client: PublicApiClient,
  threadId: string,
  jobId: string
): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/threads/${threadId}/jobs/${jobId}/confirm-plan`,
    {},
    { operationId: 'plan.confirm' }
  )
  if (result.status >= 400) {
    throw new Error(`plan.confirm_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return unwrapJob(result.data) ?? result.data
}

export async function confirmPlanNode(
  client: PublicApiClient,
  threadId: string,
  jobId: string,
  nodeRef: string
): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/threads/${threadId}/jobs/${jobId}/plan/nodes/${encodeURIComponent(nodeRef)}/confirm`,
    {},
    { operationId: 'plan.node_confirm' }
  )
  if (result.status >= 400) {
    throw new Error(`plan.node_confirm_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function createJob(
  client: PublicApiClient,
  threadId: string,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const result = await client.request<Record<string, unknown>>(
    'POST',
    `/api/threads/${threadId}/jobs`,
    body,
    { operationId: 'job.create' }
  )
  if (result.status >= 400) {
    throw new Error(`job.create_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  const job = unwrapJob(result.data)
  if (!job) throw new Error('job.create_empty')
  return job
}

export async function getTaskEvidence(
  client: PublicApiClient,
  threadId: string,
  jobId: string,
  taskId: string
): Promise<unknown> {
  const result = await client.request(
    'GET',
    `/api/threads/${threadId}/jobs/${jobId}/tasks/${taskId}/evidence`,
    undefined,
    { operationId: 'job.task_evidence' }
  )
  if (result.status >= 400) {
    throw new Error(`job.evidence_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function waitJobTerminal(
  client: PublicApiClient,
  threadId: string,
  jobId: string,
  timeoutMs = TIMEOUTS.caseTotalMs
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await getJob(client, threadId, jobId)
    const status = String(job.status ?? '')
    if (['completed', 'failed', 'cancelled'].includes(status)) return job
    await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.turnPollMs))
  }
  throw new Error(`timeout:job_${jobId}`)
}

export async function updateDraft(
  client: PublicApiClient,
  threadId: string,
  messageId: string,
  patch: Record<string, unknown>
): Promise<unknown> {
  const result = await client.request(
    'PATCH',
    `/api/threads/${threadId}/messages/${messageId}/draft`,
    patch,
    { operationId: 'draft.update' }
  )
  if (result.status >= 400) {
    throw new Error(`draft.update_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function unlockDraft(
  client: PublicApiClient,
  threadId: string,
  messageId: string
): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/threads/${threadId}/messages/${messageId}/draft/unlock`,
    {},
    { operationId: 'draft.unlock' }
  )
  if (result.status >= 400) {
    throw new Error(`draft.unlock_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function unlockDraftContract(
  client: PublicApiClient,
  threadId: string,
  messageId: string
): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/threads/${threadId}/messages/${messageId}/draft/unlock-contract`,
    {},
    { operationId: 'draft.unlock_contract' }
  )
  if (result.status >= 400) {
    throw new Error(`draft.unlock_contract_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function confirmDraftSection(
  client: PublicApiClient,
  threadId: string,
  messageId: string,
  section: string
): Promise<unknown> {
  const result = await client.request(
    'POST',
    `/api/threads/${threadId}/messages/${messageId}/draft/sections/${encodeURIComponent(section)}/confirm`,
    {},
    { operationId: 'draft.section_confirm' }
  )
  if (result.status >= 400) {
    throw new Error(`draft.section_confirm_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function updateDraftAbilities(
  client: PublicApiClient,
  threadId: string,
  messageId: string,
  selections: Array<{ abilityCode: string; coreCode: string }>
): Promise<unknown> {
  const result = await client.request(
    'PATCH',
    `/api/threads/${threadId}/messages/${messageId}/draft/abilities`,
    { selections },
    { operationId: 'draft.abilities' }
  )
  if (result.status >= 400) {
    throw new Error(`draft.abilities_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
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
    `/api/threads/${threadId}/attachments`,
    form,
    { operationId: 'attachment.upload' }
  )
  if (result.status >= 400) {
    throw new Error(`attachment.upload_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function putControlPlanePolicies(
  client: PublicApiClient,
  input: {
    plannerCoreCode: string
    sliceVerifierCoreCode: string
    milestoneVerifierCoreCode: string
  }
): Promise<unknown> {
  const result = await client.request('PUT', '/api/settings/control-plane', input, {
    operationId: 'settings.control_plane.put'
  })
  if (result.status >= 400) {
    throw new Error(
      `settings.control_plane_failed:${result.status}:${result.raw.message ?? ''}`
    )
  }
  return result.data
}

export async function getControlPlanePolicies(client: PublicApiClient): Promise<unknown> {
  const result = await client.request('GET', '/api/settings/control-plane', undefined, {
    operationId: 'settings.control_plane.get'
  })
  if (result.status >= 400) {
    throw new Error(
      `settings.control_plane_get_failed:${result.status}:${result.raw.message ?? ''}`
    )
  }
  return result.data
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
  settings: unknown
): Promise<{ settings: unknown }> {
  const result = await client.request<{ settings: unknown }>(
    'PUT',
    '/api/settings/mcp',
    { settings },
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

export async function pauseJob(
  client: PublicApiClient,
  jobId: string
): Promise<unknown> {
  const result = await client.request('POST', `/api/jobs/${jobId}/pause`, {}, {
    operationId: 'job.pause'
  })
  if (result.status >= 400) {
    throw new Error(`job.pause_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function resumeJob(
  client: PublicApiClient,
  jobId: string
): Promise<unknown> {
  const result = await client.request('POST', `/api/jobs/${jobId}/resume`, {}, {
    operationId: 'job.resume'
  })
  if (result.status >= 400) {
    throw new Error(`job.resume_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function continueJob(
  client: PublicApiClient,
  jobId: string
): Promise<unknown> {
  const result = await client.request('POST', `/api/jobs/${jobId}/continue`, {}, {
    operationId: 'job.continue'
  })
  if (result.status >= 400) {
    throw new Error(`job.continue_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function cancelJob(
  client: PublicApiClient,
  jobId: string
): Promise<unknown> {
  const result = await client.request('POST', `/api/jobs/${jobId}/cancel`, {}, {
    operationId: 'job.cancel'
  })
  if (result.status >= 400) {
    throw new Error(`job.cancel_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

export async function restartJob(
  client: PublicApiClient,
  jobId: string
): Promise<unknown> {
  const result = await client.request('POST', `/api/jobs/${jobId}/restart`, {}, {
    operationId: 'job.restart'
  })
  if (result.status >= 400) {
    throw new Error(`job.restart_failed:${result.status}:${result.raw.message ?? ''}`)
  }
  return result.data
}

