import { Hono } from 'hono'
import { Value } from '@sinclair/typebox/value'
import { JobCommandBodySchema } from '@codetask/contracts'
import type { QueryJobService } from '../application/query-job.ts'
import type { ControlJobService } from '../application/control-job.ts'
import type { DeleteJobService } from '../application/delete-job.ts'
import type { QueueRepository } from '../../queue/infrastructure/queue-repository.ts'
import type { Actor } from '../../shared.ts'
import {
  ExecutionConflictError,
  ExecutionForbiddenError,
  ExecutionNotFoundError,
  ExecutionValidationError
} from '../../shared.ts'

export type ExecutionHttpEnv = {
  Variables: {
    actor: Actor
    requestId: string
  }
}

function ok<T>(data: T, requestId: string) {
  return { success: true as const, data, requestId }
}

function fail(code: string, message: string, requestId: string) {
  return {
    success: false as const,
    error: { code, message },
    requestId
  }
}

function mapError(error: unknown, requestId: string) {
  if (error instanceof ExecutionConflictError) {
    return { body: fail(error.code, error.message, requestId), status: 409 as const }
  }
  if (error instanceof ExecutionValidationError) {
    return { body: fail(error.code, error.message, requestId), status: 400 as const }
  }
  if (error instanceof ExecutionNotFoundError) {
    return { body: fail(error.code, error.message, requestId), status: 404 as const }
  }
  if (error instanceof ExecutionForbiddenError) {
    return { body: fail(error.code, error.message, requestId), status: 403 as const }
  }
  return {
    body: fail(
      'execution.internal',
      error instanceof Error ? error.message : String(error),
      requestId
    ),
    status: 500 as const
  }
}

function requireActor(c: { get: (k: 'actor') => Actor | undefined }): Actor {
  const actor = c.get('actor')
  if (!actor) throw new ExecutionForbiddenError('Missing actor')
  return actor
}

export function createJobRoutes(deps: {
  query: QueryJobService
  control: ControlJobService
  deleteJob: DeleteJobService
  queue: QueueRepository
}): Hono<ExecutionHttpEnv> {
  const app = new Hono<ExecutionHttpEnv>()

  app.get('/', async (c) => {
    try {
      const actor = requireActor(c)
      const data = await deps.query.list(actor)
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status)
    }
  })

  app.get('/:jobId', async (c) => {
    try {
      const actor = requireActor(c)
      const data = await deps.query.get(actor, c.req.param('jobId'))
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status)
    }
  })

  app.get('/:jobId/tree', async (c) => {
    try {
      const actor = requireActor(c)
      const data = await deps.query.getTree(actor, c.req.param('jobId'))
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status)
    }
  })

  app.get('/:jobId/work/:workId', async (c) => {
    try {
      const actor = requireActor(c)
      const data = await deps.query.getWork(actor, c.req.param('jobId'), c.req.param('workId'))
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status)
    }
  })

  app.get('/:jobId/work/:workId/evidence', async (c) => {
    try {
      const actor = requireActor(c)
      const data = await deps.query.getEvidence(
        actor,
        c.req.param('jobId'),
        c.req.param('workId')
      )
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status)
    }
  })

  app.get('/:jobId/verifications', async (c) => {
    try {
      const actor = requireActor(c)
      const data = await deps.query.listVerifications(actor, c.req.param('jobId'))
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status)
    }
  })

  app.post('/:jobId/pause', async (c) => {
    try {
      const actor = requireActor(c)
      const body = Value.Parse(JobCommandBodySchema, await c.req.json())
      const data = deps.control.pause(actor, c.req.param('jobId'), body)
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status)
    }
  })

  app.post('/:jobId/continue', async (c) => {
    try {
      const actor = requireActor(c)
      const body = Value.Parse(JobCommandBodySchema, await c.req.json())
      const data = deps.control.continue(actor, c.req.param('jobId'), body)
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status)
    }
  })

  app.post('/:jobId/cancel', async (c) => {
    try {
      const actor = requireActor(c)
      const body = Value.Parse(JobCommandBodySchema, await c.req.json())
      const data = deps.control.cancel(actor, c.req.param('jobId'), body)
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status)
    }
  })

  app.post('/:jobId/restart', async (c) => {
    try {
      const actor = requireActor(c)
      const body = Value.Parse(JobCommandBodySchema, await c.req.json())
      const data = deps.control.restart(actor, c.req.param('jobId'), body)
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status)
    }
  })

  app.delete('/:jobId', async (c) => {
    try {
      const actor = requireActor(c)
      const body = Value.Parse(JobCommandBodySchema, await c.req.json())
      const data = deps.deleteJob.delete(actor, c.req.param('jobId'), body)
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status)
    }
  })

  return app
}

export function createExecutionQueueRoute(deps: { queue: QueueRepository }): Hono<ExecutionHttpEnv> {
  const app = new Hono<ExecutionHttpEnv>()
  app.get('/', async (c) => {
    try {
      requireActor(c)
      const data = deps.queue.listQueued()
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status)
    }
  })
  return app
}
