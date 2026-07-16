import { Hono } from 'hono'
import type { AppContext } from '../context'
import { AppError } from '../error'
import { requireUsername } from '../auth/session'
import { ok } from '../response'
import {
  applyChangeSet,
  cancelChangeSet,
  createChangeSet,
  getChangeSet,
  listProjectChangeSets,
  markChangeSetReady,
  rebaseChangeSet
} from '../change-set/service'

async function readExpectedRevision(c: {
  req: { json: <T>() => Promise<T> }
}): Promise<number | undefined> {
  try {
    const body = await c.req.json<{ expectedRevision?: number }>()
    if (body.expectedRevision !== undefined && typeof body.expectedRevision !== 'number') {
      throw AppError.badRequest('expectedRevision must be a number', 'change_set.invalid_revision')
    }
    return body.expectedRevision
  } catch (error) {
    if (error instanceof AppError) throw error
    return undefined
  }
}

export function createProjectChangeSetRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/:projectId/change-sets', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const rows = await listProjectChangeSets(username, c.req.param('projectId'))
    return c.json(ok(rows))
  })

  routes.post('/:projectId/change-sets', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{
      sourceThreadId?: string | null
      sourceTurnId?: string | null
      applyPolicy?: string
    }>()
    const accepted = await createChangeSet(username, {
      projectId: c.req.param('projectId'),
      sourceThreadId: body.sourceThreadId,
      sourceTurnId: body.sourceTurnId,
      applyPolicy: body.applyPolicy
    })
    return c.json(ok(accepted), 202)
  })

  return routes
}

export function createChangeSetRoutes(_ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/:changeSetId', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const row = await getChangeSet(username, c.req.param('changeSetId'))
    return c.json(ok(row))
  })

  routes.post('/:changeSetId/ready', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const expectedRevision = await readExpectedRevision(c)
    const row = await markChangeSetReady(username, c.req.param('changeSetId'), expectedRevision)
    return c.json(ok(row))
  })

  routes.post('/:changeSetId/apply', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const expectedRevision = await readExpectedRevision(c)
    const row = await applyChangeSet(username, c.req.param('changeSetId'), expectedRevision)
    return c.json(ok(row))
  })

  routes.post('/:changeSetId/rebase', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const expectedRevision = await readExpectedRevision(c)
    const row = await rebaseChangeSet(username, c.req.param('changeSetId'), expectedRevision)
    return c.json(ok(row))
  })

  routes.post('/:changeSetId/cancel', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const expectedRevision = await readExpectedRevision(c)
    const row = await cancelChangeSet(username, c.req.param('changeSetId'), expectedRevision)
    return c.json(ok(row))
  })

  return routes
}
