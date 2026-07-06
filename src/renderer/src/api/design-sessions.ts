import { authHeaders } from '@renderer/auth/token'
import type { DraftReference } from '@shared/reference-corpus'
import type { JobReferenceManifestDto } from '@shared/job-references'
import { api, ApiError } from './client'
import type { ApiResponse } from './types'

export function fetchDesignSessionReferences(
  threadId: string,
  designSessionId: string
): Promise<ApiResponse<{ references: DraftReference[] }>> {
  return api<{ references: DraftReference[] }>(
    `/api/threads/${threadId}/design-sessions/${designSessionId}/references`
  )
}

export function addDesignSessionLocalCorpus(
  threadId: string,
  designSessionId: string,
  input: {
    localPath: string
    name: string
    description: string
    kind?: 'file' | 'directory'
  }
): Promise<ApiResponse<{ reference: DraftReference }>> {
  return api<{ reference: DraftReference }>(
    `/api/threads/${threadId}/design-sessions/${designSessionId}/references/local-corpus`,
    {
      method: 'POST',
      body: JSON.stringify(input)
    }
  )
}

export function updateDesignSessionReference(
  threadId: string,
  designSessionId: string,
  refId: string,
  patch: { description?: string; name?: string }
): Promise<ApiResponse<{ reference: DraftReference }>> {
  return api<{ reference: DraftReference }>(
    `/api/threads/${threadId}/design-sessions/${designSessionId}/references/${refId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch)
    }
  )
}

export function removeDesignSessionReference(
  threadId: string,
  designSessionId: string,
  refId: string
): Promise<ApiResponse<{ removed: boolean }>> {
  return api<{ removed: boolean }>(
    `/api/threads/${threadId}/design-sessions/${designSessionId}/references/${refId}`,
    { method: 'DELETE' }
  )
}

export function freezeDesignSessionReferences(
  threadId: string,
  designSessionId: string
): Promise<ApiResponse<{ manifest: JobReferenceManifestDto }>> {
  return api<{ manifest: JobReferenceManifestDto }>(
    `/api/threads/${threadId}/design-sessions/${designSessionId}/references/freeze`,
    { method: 'POST' }
  )
}

export async function uploadDesignSessionReference(
  threadId: string,
  designSessionId: string,
  file: File,
  description?: string
): Promise<DraftReference[]> {
  const form = new FormData()
  form.append('file', file)
  if (description?.trim()) form.append('description', description.trim())

  const res = await fetch(
    `/api/threads/${threadId}/design-sessions/${designSessionId}/references/attachment`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: form
    }
  )
  if (!res.ok) {
    const raw = await res.text()
    throw new ApiError(raw || 'upload failed', res.status, null)
  }
  const body = (await res.json()) as { data?: { references?: DraftReference[] } }
  return body.data?.references ?? []
}
