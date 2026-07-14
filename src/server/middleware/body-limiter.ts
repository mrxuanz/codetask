import type { MiddlewareHandler } from 'hono'

export const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024
export const MAX_FORM_BODY_BYTES = 4 * 1024 * 1024
export const MAX_DEFAULT_BODY_BYTES = MAX_JSON_BODY_BYTES

const PAYLOAD_TOO_LARGE_STATUS = 41301

function payloadTooLarge(): Response {
  return new Response(
    JSON.stringify({
      data: null,
      status: PAYLOAD_TOO_LARGE_STATUS,
      extra: {},
      message: 'Request body too large',
      success: false
    }),
    {
      status: 413,
      headers: { 'Content-Type': 'application/json' }
    }
  )
}

async function readBodyWithLimit(
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<{ body: Uint8Array; tooLarge: boolean }> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return { body: new Uint8Array(0), tooLarge: true }
    }
    chunks.push(value)
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { body: merged, tooLarge: false }
}

export function resolveBodyLimit(contentType: string | undefined, explicitLimit?: number): number {
  if (explicitLimit !== undefined) return explicitLimit
  const normalized = contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (normalized === 'multipart/form-data') {
    return MAX_FORM_BODY_BYTES
  }
  if (normalized === 'application/x-www-form-urlencoded') {
    return MAX_FORM_BODY_BYTES
  }
  if (normalized === 'application/json' || normalized === 'application/problem+json') {
    return MAX_JSON_BODY_BYTES
  }
  return MAX_DEFAULT_BODY_BYTES
}

export function bodySizeLimit(maxBytes?: number): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next()
    }

    const limit = resolveBodyLimit(c.req.header('Content-Type'), maxBytes)
    const contentLength = c.req.header('Content-Length')
    if (contentLength) {
      const size = Number.parseInt(contentLength, 10)
      if (!Number.isNaN(size) && size > limit) {
        return payloadTooLarge()
      }
    }

    const rawBody = c.req.raw.body
    if (rawBody) {
      const { body, tooLarge } = await readBodyWithLimit(rawBody, limit)
      if (tooLarge) {
        return payloadTooLarge()
      }

      c.req.raw = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: body.byteLength > 0 ? Buffer.from(body) : null
      })
    }

    return next()
  }
}
