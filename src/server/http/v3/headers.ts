export function parseIfMatch(header: string | undefined): number {
  if (!header) throw new Error('If-Match header required')
  const match = header.match(/^"(\d+)"$/)
  if (!match) throw new Error('Invalid If-Match format, expected "revision"')
  const revision = match[1]
  if (revision === undefined) throw new Error('Invalid If-Match format, expected "revision"')
  return parseInt(revision, 10)
}

export function parseIdempotencyKey(header: string | undefined): string {
  if (!header) throw new Error('Idempotency-Key header required')
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(header)) throw new Error('Invalid Idempotency-Key format, expected UUID')
  return header
}

export function formatETag(revision: number): string {
  return `"${revision}"`
}
