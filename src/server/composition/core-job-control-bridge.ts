/**
 * Bridge: production `/api/jobs/*` control → new-core handlers.
 *
 * Always tries core first. If the job is missing from the core store,
 * returns `null` so legacy can run.
 *
 * Core-authoritative when present: mutations (pause/continue/cancel/retry/delete)
 * persist only to the core store — no dual-write back to legacy inside `core/**`.
 *
 * Successful responses are shaped by `createJobRoutes` → `mapJobToLegacy`
 * (legacy-api-mapper). DELETE has no domain hard-delete: maps to cancel
 * (or no-op acknowledge for already-terminal completed/cancelled).
 */
import type { Context } from 'hono'
import type { ApplicationHandle } from './types'
import { createJobRoutes } from '../interfaces/http/routes/jobs'
import { toHttpRequest, sendHttpResult } from '../interfaces/http/hono-mount'
import { cancelJobCommand } from '../core/application/commands/cancel-job'
import { projectJob } from '../core/application/queries/get-job'
import { mapJobToLegacy } from '../compatibility/legacy-api-mapper'
import { ok } from '../response'

export type CoreJobControlAction = 'get' | 'pause' | 'continue' | 'cancel' | 'retry'

function coreJobRoutes(core: ApplicationHandle) {
  return createJobRoutes({
    jobs: core.jobs,
    unitOfWork: core.unitOfWork,
    idempotency: core.idempotency
  })
}

/**
 * Dispatch one job-control action through new-core.
 * @returns Hono response, or `null` when job not in core (caller falls back).
 */
export async function tryCoreJobControl(
  c: Context,
  action: CoreJobControlAction,
  jobId: string,
  core: ApplicationHandle | null | undefined
): Promise<Response | null> {
  if (!core) return null

  const existing = await core.jobs.get(jobId)
  if (!existing) return null

  const routes = coreJobRoutes(core)
  const headers: Record<string, string | undefined> = {}
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  // Legacy clients often omit If-Match / expectedRevision — use current core revision.
  if (!headers['idempotency-key']) {
    headers['idempotency-key'] = `core-bridge:${action}:${jobId}:${existing.stateRevision}`
  }

  let body: unknown = undefined
  if (action !== 'get') {
    try {
      const contentType = headers['content-type'] ?? ''
      if (contentType.includes('application/json')) {
        body = await c.req.json()
      }
    } catch {
      body = {}
    }
    if (body === undefined || body === null || typeof body !== 'object') {
      body = {}
    }
    const record = body as Record<string, unknown>
    if (record.expectedRevision === undefined && record.revision === undefined) {
      body = { ...record, expectedRevision: existing.stateRevision }
    }
  }

  const request = {
    ...(await toHttpRequest(c, { jobId })),
    headers: {
      ...headers,
      'if-match': headers['if-match'] ?? String(existing.stateRevision)
    },
    body
  }

  const result =
    action === 'get'
      ? await routes.getJob(request)
      : action === 'pause'
        ? await routes.pause(request)
        : action === 'continue'
          ? await routes.continue(request)
          : action === 'cancel'
            ? await routes.cancel(request)
            : await routes.retry(request)

  return sendHttpResult(c, result) as unknown as Response
}

/**
 * Core-first DELETE: domain has no hard delete — cancel (or acknowledge terminal).
 * Returns `{ deleted: true, job }` with mapper-shaped job, or `null` to fall back.
 */
export async function tryCoreJobDelete(
  c: Context,
  jobId: string,
  core: ApplicationHandle | null | undefined
): Promise<Response | null> {
  if (!core) return null

  const existing = await core.jobs.get(jobId)
  if (!existing) return null

  let job = existing

  // completed: cancel is illegal — acknowledge delete without mutation.
  // cancelled: idempotent no-op.
  if (existing.status !== 'completed' && existing.status !== 'cancelled') {
    const idempotencyKey = `core-bridge:delete:${jobId}:${existing.stateRevision}`
    const result = await cancelJobCommand(
      {
        jobs: core.jobs,
        unitOfWork: core.unitOfWork,
        idempotency: core.idempotency
      },
      {
        jobId,
        expectedRevision: existing.stateRevision,
        idempotencyKey,
        payloadHash: JSON.stringify({ jobId, action: 'delete' })
      }
    )
    if (!result.ok) return null
    job = result.value.job
  }

  return c.json(
    ok({
      deleted: true,
      job: mapJobToLegacy(projectJob(job))
    })
  ) as unknown as Response
}
