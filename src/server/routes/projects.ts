import { Hono } from 'hono'
import { Type, type Static } from '@sinclair/typebox'
import type { AppContext } from '../context'
import { AppError } from '../error'
import { requireActorUserId } from '../auth/session'
import {
  createProject,
  deleteProject,
  getProject,
  getProjectWorkspaceAccess,
  listProjects
} from '../projects/service'
import { ok } from '../response'
import { parseJsonBody } from '../http/json-body'

const CreateProjectBodySchema = Type.Object(
  {
    workspaceRoot: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    createIfMissing: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
)

function requestId(c: { get: (key: never) => unknown }): string {
  return (c.get('requestId' as never) as string | undefined) ?? 'unknown'
}

export function createProjectRoutes(_ctx: AppContext): Hono {
  const projectRoutes = new Hono()

  projectRoutes.get('/', async (c) => {
    const actorId = requireActorUserId()
    const rows = await listProjects(actorId)
    return c.json(ok(rows, requestId(c)))
  })

  projectRoutes.post('/', async (c) => {
    const actorId = requireActorUserId()
    const body = await parseJsonBody<Static<typeof CreateProjectBodySchema>>(
      c,
      CreateProjectBodySchema,
      'Invalid create project body'
    )

    if (!body.workspaceRoot?.trim()) {
      throw AppError.badRequest('workspaceRoot is required', 'project.workspace_root_required')
    }

    const row = await createProject(
      actorId,
      body.workspaceRoot.trim(),
      body.title,
      body.createIfMissing ?? true
    )
    return c.json(ok(row, requestId(c)))
  })

  projectRoutes.get('/:projectId/workspace-access', async (c) => {
    const actorId = requireActorUserId()
    const access = await getProjectWorkspaceAccess(actorId, c.req.param('projectId'))
    return c.json(ok(access, requestId(c)))
  })

  projectRoutes.get('/:projectId', async (c) => {
    const actorId = requireActorUserId()
    const row = await getProject(actorId, c.req.param('projectId'))
    if (!row) {
      throw AppError.notFound('Project not found', 'project.not_found')
    }
    return c.json(ok(row, requestId(c)))
  })

  projectRoutes.delete('/:projectId', async (c) => {
    const actorId = requireActorUserId()
    await deleteProject(actorId, c.req.param('projectId'))
    return c.json(ok({ deleted: true }, requestId(c)))
  })

  return projectRoutes
}
