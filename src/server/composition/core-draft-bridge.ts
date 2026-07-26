/**
 * Bridge: production draft get/confirm/patch/section/unlock/confirm-final → new-core
 * `createDraftRoutes`.
 *
 * Wired by production `/api/drafts/:draftId/*` and thread-route best-effort when
 * `body.draftId` is present. Legacy list/delete stay thread/message keyed.
 */
import type { Context } from 'hono'
import type { ApplicationHandle } from './types'
import { createDraftRoutes } from '../interfaces/http/routes/drafts'
import { toHttpRequest, sendHttpResult } from '../interfaces/http/hono-mount'

function coreDraftRoutes(core: ApplicationHandle) {
  return createDraftRoutes({
    drafts: core.drafts,
    unitOfWork: core.unitOfWork,
    idempotency: core.idempotency,
    jobs: core.jobs,
    plans: core.plans,
    ids: core.ids
  })
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const headers: Record<string, string | undefined> = {}
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  let body: unknown = {}
  try {
    const contentType = headers['content-type'] ?? ''
    if (contentType.includes('application/json')) {
      body = await c.req.json()
    }
  } catch {
    body = {}
  }
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {}
  }
  return body as Record<string, unknown>
}

function collectHeaders(c: Context): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  return headers
}

function ensureIdempotencyAndRevision(
  headers: Record<string, string | undefined>,
  body: Record<string, unknown>,
  bridgeKey: string,
  revision: number
): { headers: Record<string, string | undefined>; body: Record<string, unknown> } {
  const nextHeaders = { ...headers }
  if (!nextHeaders['idempotency-key']) {
    nextHeaders['idempotency-key'] = bridgeKey
  }
  let nextBody = body
  if (
    nextBody.expectedRevision === undefined &&
    nextBody.revision === undefined
  ) {
    nextBody = { ...nextBody, expectedRevision: revision }
  }
  return { headers: nextHeaders, body: nextBody }
}

/**
 * Fetch one draft through new-core.
 * @returns Hono response, or `null` when draft not in core (caller may fall back).
 */
export async function tryCoreDraftGet(
  c: Context,
  draftId: string,
  core: ApplicationHandle | null | undefined
): Promise<Response | null> {
  if (!core) return null

  const existing = await core.drafts.get(draftId)
  if (!existing) return null

  const routes = coreDraftRoutes(core)
  const request = await toHttpRequest(c, { draftId })
  const result = await routes.getDraft(request)
  return sendHttpResult(c, result) as unknown as Response
}

/**
 * Confirm a draft through new-core (idempotency + expectedRevision plumbing).
 * @returns Hono response, or `null` when draft not in core (caller may fall back).
 */
export async function tryCoreDraftConfirm(
  c: Context,
  draftId: string,
  core: ApplicationHandle | null | undefined
): Promise<Response | null> {
  if (!core) return null

  const existing = await core.drafts.get(draftId)
  if (!existing) return null

  const routes = coreDraftRoutes(core)
  const headers = collectHeaders(c)
  const body = await readJsonBody(c)
  const prepared = ensureIdempotencyAndRevision(
    headers,
    body,
    `core-bridge:confirm-draft:${draftId}:${existing.revision}`,
    existing.revision
  )

  const request = {
    ...(await toHttpRequest(c, { draftId })),
    headers: prepared.headers,
    body: prepared.body
  }

  const result = await routes.confirmDraft(request)
  return sendHttpResult(c, result) as unknown as Response
}

/**
 * Patch draft content/payload through new-core.
 * @returns Hono response, or `null` when draft not in core.
 */
export async function tryCoreDraftPatch(
  c: Context,
  draftId: string,
  core: ApplicationHandle | null | undefined,
  preParsedBody?: Record<string, unknown>
): Promise<Response | null> {
  if (!core) return null

  const existing = await core.drafts.get(draftId)
  if (!existing) return null

  const routes = coreDraftRoutes(core)
  const headers = collectHeaders(c)
  const body = preParsedBody ?? (await readJsonBody(c))
  const prepared = ensureIdempotencyAndRevision(
    headers,
    body,
    `core-bridge:patch-draft:${draftId}:${existing.revision}`,
    existing.revision
  )

  const request = {
    ...(await toHttpRequest(c, { draftId })),
    headers: prepared.headers,
    body: prepared.body
  }

  const result = await routes.patchDraft(request)
  return sendHttpResult(c, result) as unknown as Response
}

/**
 * Confirm a draft section through new-core.
 * @returns Hono response, or `null` when draft not in core.
 */
export async function tryCoreDraftSectionConfirm(
  c: Context,
  draftId: string,
  section: string,
  core: ApplicationHandle | null | undefined,
  preParsedBody?: Record<string, unknown>
): Promise<Response | null> {
  if (!core) return null

  const existing = await core.drafts.get(draftId)
  if (!existing) return null

  const routes = coreDraftRoutes(core)
  const headers = collectHeaders(c)
  const body = preParsedBody ?? (await readJsonBody(c))
  const prepared = ensureIdempotencyAndRevision(
    headers,
    body,
    `core-bridge:confirm-section:${draftId}:${section}:${existing.revision}`,
    existing.revision
  )

  const request = {
    ...(await toHttpRequest(c, { draftId, section })),
    headers: prepared.headers,
    body: prepared.body
  }

  const result = await routes.confirmDraftSection(request)
  return sendHttpResult(c, result) as unknown as Response
}

/**
 * Unlock a draft through new-core (cancel linked job when present).
 * @returns Hono response, or `null` when draft not in core.
 */
export async function tryCoreDraftUnlock(
  c: Context,
  draftId: string,
  core: ApplicationHandle | null | undefined,
  preParsedBody?: Record<string, unknown>
): Promise<Response | null> {
  if (!core) return null

  const existing = await core.drafts.get(draftId)
  if (!existing) return null

  const routes = coreDraftRoutes(core)
  const headers = collectHeaders(c)
  const body = preParsedBody ?? (await readJsonBody(c))
  const prepared = ensureIdempotencyAndRevision(
    headers,
    body,
    `core-bridge:unlock-draft:${draftId}:${existing.revision}`,
    existing.revision
  )

  const request = {
    ...(await toHttpRequest(c, { draftId })),
    headers: prepared.headers,
    body: prepared.body
  }

  const result = await routes.unlockDraft(request)
  return sendHttpResult(c, result) as unknown as Response
}

/**
 * Confirm-final: freeze draft + enqueue/create queued job when thread/project
 * resolvable. Returns `null` when draft missing or unresolvable → legacy fallback.
 */
export async function tryCoreDraftConfirmFinal(
  c: Context,
  draftId: string,
  core: ApplicationHandle | null | undefined,
  preParsedBody?: Record<string, unknown>
): Promise<Response | null> {
  if (!core) return null

  const existing = await core.drafts.get(draftId)
  if (!existing) return null
  if (!existing.threadId.trim() || !existing.projectId.trim()) return null

  const routes = coreDraftRoutes(core)
  const headers = collectHeaders(c)
  const body = preParsedBody ?? (await readJsonBody(c))
  const prepared = ensureIdempotencyAndRevision(
    headers,
    body,
    `core-bridge:confirm-final:${draftId}:${existing.revision}`,
    existing.revision
  )

  const request = {
    ...(await toHttpRequest(c, { draftId })),
    headers: prepared.headers,
    body: prepared.body
  }

  const result = await routes.confirmDraftFinal(request)
  return sendHttpResult(c, result) as unknown as Response
}
