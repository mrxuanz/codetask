import type { CancelJobPayload } from '@shared/contracts/control-plane'
import { commandError } from '../../domain/jobs/job-errors'

export const MAX_LIST_LIMIT = 100
export const DEFAULT_LIST_LIMIT = 50

export function parseJobId(jobId: string | undefined): string {
  if (jobId === undefined || jobId.trim().length === 0) {
    throw commandError('contract.invalid_payload', { field: 'jobId' })
  }
  return jobId
}

export function parseIfMatch(header: string | undefined): number {
  if (!header) {
    throw commandError('contract.invalid_payload', { field: 'If-Match', reason: 'required' })
  }
  const match = header.match(/^"(\d+)"$/)
  if (!match) {
    throw commandError('contract.invalid_payload', { field: 'If-Match' })
  }
  const revisionText = match[1]
  if (revisionText === undefined) {
    throw commandError('contract.invalid_payload', { field: 'If-Match' })
  }
  const revision = Number(revisionText)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw commandError('contract.invalid_payload', { field: 'If-Match' })
  }
  return revision
}

export function parseIdempotencyKey(header: string | undefined): string {
  if (!header) {
    throw commandError('contract.invalid_payload', { field: 'Idempotency-Key', reason: 'required' })
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(header)) {
    throw commandError('contract.invalid_payload', { field: 'Idempotency-Key' })
  }
  return header
}

export function parseCancelJobPayload(body: unknown): CancelJobPayload {
  if (body === undefined) return { reasonCode: 'user_cancelled' }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw commandError('contract.invalid_payload', { field: 'body' })
  }

  const payload = body as Record<string, unknown>
  if (
    Object.keys(payload).some((key) => key !== 'reasonCode') ||
    (payload.reasonCode !== undefined &&
      (typeof payload.reasonCode !== 'string' || payload.reasonCode.length === 0))
  ) {
    throw commandError('contract.invalid_payload', { field: 'reasonCode' })
  }

  return { reasonCode: payload.reasonCode ?? 'user_cancelled' }
}

export interface ParsedListJobsQuery {
  readonly projectId?: string
  readonly status?: string
  readonly page: number
  readonly limit: number
  readonly q?: string
}

function parsePositiveIntField(
  raw: string | undefined,
  field: string,
  fallback: number,
  max?: number
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw commandError('contract.invalid_payload', { field })
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw commandError('contract.invalid_payload', { field })
  }
  if (max !== undefined && parsed > max) {
    throw commandError('contract.invalid_payload', { field, max })
  }
  return parsed
}

export function parseListJobsQuery(query?: Record<string, string>): ParsedListJobsQuery {
  const page = parsePositiveIntField(query?.page, 'page', 1)
  const limit = parsePositiveIntField(query?.limit, 'limit', DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
  const projectId = query?.projectId?.trim()
  const status = query?.status?.trim()
  const q = query?.q?.trim()

  return {
    ...(projectId ? { projectId } : {}),
    ...(status ? { status } : {}),
    page,
    limit,
    ...(q ? { q } : {})
  }
}

export function readRequiredJsonBody(body: unknown): unknown {
  if (body === undefined) {
    throw commandError('contract.invalid_payload', { field: 'body', reason: 'required' })
  }
  return body
}
