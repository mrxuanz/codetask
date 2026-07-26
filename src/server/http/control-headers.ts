import { commandError } from '../domain/jobs/job-errors'

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
    throw commandError('contract.invalid_payload', {
      field: 'Idempotency-Key',
      reason: 'required'
    })
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(header)) {
    throw commandError('contract.invalid_payload', { field: 'Idempotency-Key' })
  }
  return header
}

export function formatETag(revision: number): string {
  return `"${revision}"`
}
