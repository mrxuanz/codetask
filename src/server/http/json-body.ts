import type { Context } from 'hono'
import type { TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { AppError } from '../error'

/** Parse and validate an HTTP JSON body before it reaches business code. */
export async function parseJsonBody<T>(
  c: Context,
  schema: TSchema,
  invalidBodyMessage = 'Invalid request body'
): Promise<T> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw AppError.badRequest('Request body must be valid JSON', 'http.invalid_json')
  }
  if (!Value.Check(schema, body)) {
    throw AppError.badRequest(invalidBodyMessage, 'http.invalid_body')
  }
  return body as T
}
