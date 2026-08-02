import { Value } from '@sinclair/typebox/value'
import {
  ConfirmDraftBodySchema,
  ConfirmTreeNodeBodySchema,
  CreateDraftBodySchema,
  CreatePlanningSessionBodySchema,
  PatchAbilitiesBodySchema,
  PatchDraftBodySchema,
  PatchExecutionProfileBodySchema,
  PatchTreeNodeBodySchema,
  PublishPlanningBodySchema,
  UnlockDraftBodySchema,
  type CreateDraftBody,
  type DraftAbility,
  type DraftReference,
  type ExecutionProfile,
  type ExecutionTreeSnapshot,
  type PatchDraftBody,
  type PlanningSessionStatus
} from '@codetask/contracts'
import { api } from './client'
import type { ApiResponse } from './types'

export type { DraftAbility, DraftReference, ExecutionProfile, ExecutionTreeSnapshot }

export type DesignDraftDto = {
  id: string
  actorId: string
  projectId: string
  title: string
  summary: string
  userFlow: string
  techStack: string
  nfr: string[]
  acceptance: Array<{ id: string; given: string; when: string; then: string }>
  verification: Array<{ command: string; appliesTo: string }>
  outOfScope: string[]
  assumptions: string[]
  requirementsMarkdown: string
  requirementsStatus: 'pending' | 'confirmed'
  lockedSections: Record<string, boolean>
  executionProfile: ExecutionProfile | null
  workspaceRoot: string
  status: 'editing' | 'confirmed' | 'archived'
  lockRevision: number
  createdAt: number
  updatedAt: number
  abilities: DraftAbility[]
  references: DraftReference[]
}

export type PlanningSessionDto = {
  id: string
  actorId: string
  projectId: string
  sourceDraftId: string
  status: PlanningSessionStatus
  treeRevision: number
  publishedJobId: string | null
  createdAt: number
  updatedAt: number
  publishedAt: number | null
}

function assertBody<T>(schema: unknown, body: unknown, label: string): asserts body is T {
  if (!Value.Check(schema as never, body)) {
    throw new Error(`Invalid ${label}`)
  }
}

export async function listDesignDrafts(options?: {
  q?: string
  completion?: 'all' | 'incomplete' | 'complete'
}): Promise<ApiResponse<DesignDraftDto[]>> {
  const params = new URLSearchParams()
  if (options?.q?.trim()) params.set('q', options.q.trim())
  if (options?.completion && options.completion !== 'all') {
    params.set('completion', options.completion)
  }
  const query = params.toString()
  return api<DesignDraftDto[]>(`/api/drafts${query ? `?${query}` : ''}`)
}

export async function createDesignDraft(
  body: CreateDraftBody
): Promise<ApiResponse<DesignDraftDto>> {
  assertBody<CreateDraftBody>(CreateDraftBodySchema, body, 'create draft')
  return api<DesignDraftDto>('/api/drafts', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export async function getDesignDraft(draftId: string): Promise<ApiResponse<DesignDraftDto>> {
  return api<DesignDraftDto>(`/api/drafts/${encodeURIComponent(draftId)}`)
}

export async function patchDesignDraft(
  draftId: string,
  body: PatchDraftBody
): Promise<ApiResponse<DesignDraftDto>> {
  assertBody<PatchDraftBody>(PatchDraftBodySchema, body, 'patch draft')
  return api<DesignDraftDto>(`/api/drafts/${encodeURIComponent(draftId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  })
}

export async function confirmDesignDraft(
  draftId: string,
  expectedRevision: number
): Promise<ApiResponse<DesignDraftDto>> {
  const body = { expectedRevision }
  assertBody(ConfirmDraftBodySchema, body, 'confirm draft')
  return api<DesignDraftDto>(`/api/drafts/${encodeURIComponent(draftId)}/confirm`, {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export async function unlockDesignDraft(
  draftId: string,
  expectedRevision: number
): Promise<ApiResponse<DesignDraftDto>> {
  const body = { expectedRevision }
  assertBody(UnlockDraftBodySchema, body, 'unlock draft')
  return api<DesignDraftDto>(`/api/drafts/${encodeURIComponent(draftId)}/unlock`, {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export async function patchDesignAbilities(
  draftId: string,
  expectedRevision: number,
  abilities: DraftAbility[]
): Promise<ApiResponse<DesignDraftDto>> {
  const body = { expectedRevision, abilities }
  assertBody(PatchAbilitiesBodySchema, body, 'abilities')
  return api<DesignDraftDto>(`/api/drafts/${encodeURIComponent(draftId)}/abilities`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  })
}

export async function patchDesignExecutionProfile(
  draftId: string,
  expectedRevision: number,
  executionProfile: ExecutionProfile
): Promise<ApiResponse<DesignDraftDto>> {
  const body = { expectedRevision, executionProfile }
  assertBody(PatchExecutionProfileBodySchema, body, 'execution profile')
  return api<DesignDraftDto>(`/api/drafts/${encodeURIComponent(draftId)}/execution-profile`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  })
}

export async function startPlanningSession(
  draftId: string,
  expectedRevision: number
): Promise<ApiResponse<PlanningSessionDto>> {
  const body = { expectedRevision }
  assertBody(CreatePlanningSessionBodySchema, body, 'planning session')
  return api<PlanningSessionDto>(
    `/api/drafts/${encodeURIComponent(draftId)}/planning-session`,
    {
      method: 'POST',
      body: JSON.stringify(body)
    }
  )
}

export async function listPlanningSessionsForDraft(
  draftId: string
): Promise<ApiResponse<PlanningSessionDto[]>> {
  return api<PlanningSessionDto[]>(
    `/api/drafts/${encodeURIComponent(draftId)}/planning-sessions`
  )
}

export async function getPlanningSession(sessionId: string): Promise<
  ApiResponse<{ session: PlanningSessionDto; tree: ExecutionTreeSnapshot | null }>
> {
  return api(`/api/planning-sessions/${encodeURIComponent(sessionId)}`)
}

export async function patchPlanningTreeNode(
  sessionId: string,
  nodeId: string,
  body: {
    expectedRevision: number
    title?: string
    description?: string
    successCriteria?: string
    contextMarkdown?: string
    abilityCode?: string
    coreCode?: string
    canRunInParallel?: boolean
    referenceIds?: string[]
    dependsOnTaskIds?: string[]
  }
): Promise<ApiResponse<ExecutionTreeSnapshot>> {
  assertBody(PatchTreeNodeBodySchema, body, 'tree patch')
  return api(
    `/api/planning-sessions/${encodeURIComponent(sessionId)}/tree/nodes/${encodeURIComponent(nodeId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body)
    }
  )
}

export async function confirmPlanningTreeNode(
  sessionId: string,
  nodeId: string,
  expectedRevision: number
): Promise<ApiResponse<ExecutionTreeSnapshot>> {
  const body = { expectedRevision }
  assertBody(ConfirmTreeNodeBodySchema, body, 'confirm node')
  return api(
    `/api/planning-sessions/${encodeURIComponent(sessionId)}/tree/nodes/${encodeURIComponent(nodeId)}/confirm`,
    {
      method: 'POST',
      body: JSON.stringify(body)
    }
  )
}

export async function publishPlanningSession(
  sessionId: string,
  expectedRevision: number,
  idempotencyKey: string
): Promise<ApiResponse<{ session: PlanningSessionDto; jobId: string }>> {
  const body = { expectedRevision, idempotencyKey }
  assertBody(PublishPlanningBodySchema, body, 'publish')
  return api(`/api/planning-sessions/${encodeURIComponent(sessionId)}/publish`, {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export async function cancelPlanningSession(
  sessionId: string
): Promise<ApiResponse<PlanningSessionDto>> {
  return api(`/api/planning-sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: 'POST',
    body: '{}'
  })
}

export async function listDesignDraftReferences(
  draftId: string
): Promise<ApiResponse<DraftReference[]>> {
  return api(`/api/drafts/${encodeURIComponent(draftId)}/references`)
}

export async function addDesignDraftReference(
  draftId: string,
  body: {
    expectedRevision: number
    name: string
    kind: DraftReference['kind']
    description: string
    source?: string
    mimeType?: string
    attachmentId?: string
    localPath?: string
    resolvedPath?: string
    assetUrl?: string
  }
): Promise<ApiResponse<DesignDraftDto>> {
  return api(`/api/drafts/${encodeURIComponent(draftId)}/references`, {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export async function patchDesignDraftReference(
  draftId: string,
  referenceId: string,
  body: { expectedRevision: number; name?: string; description?: string }
): Promise<ApiResponse<DesignDraftDto>> {
  return api(
    `/api/drafts/${encodeURIComponent(draftId)}/references/${encodeURIComponent(referenceId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body)
    }
  )
}

export async function deleteDesignDraftReference(
  draftId: string,
  referenceId: string,
  expectedRevision: number
): Promise<ApiResponse<DesignDraftDto>> {
  return api(
    `/api/drafts/${encodeURIComponent(draftId)}/references/${encodeURIComponent(referenceId)}`,
    {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision })
    }
  )
}

export function planningSessionTopic(sessionId: string): `planning-session:${string}` {
  return `planning-session:${sessionId}`
}
