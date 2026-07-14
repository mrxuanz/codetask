import { Hono } from 'hono'
import type { AppContext } from '../context'
import { AppError } from '../error'
import { requireUsername } from '../auth/session'
import { createProject, deleteProject, getProject, listProjects } from '../projects/service'
import { ok } from '../response'

export function createProjectRoutes(_ctx: AppContext): Hono {
  const projectRoutes = new Hono()

  projectRoutes.get('/', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const rows = await listProjects(username)
    return c.json(ok(rows))
  })

  projectRoutes.post('/', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{
      workspaceRoot?: string
      title?: string
      createIfMissing?: boolean
    }>()

    if (!body.workspaceRoot?.trim()) {
      throw AppError.badRequest('workspaceRoot is required', 'project.workspace_root_required')
    }

    const row = await createProject(
      username,
      body.workspaceRoot.trim(),
      body.title,
      body.createIfMissing ?? true
    )
    return c.json(ok(row))
  })

  projectRoutes.get('/:projectId', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    const row = await getProject(username, c.req.param('projectId'))
    if (!row) {
      throw AppError.notFound('Project not found', 'project.not_found')
    }
    return c.json(ok(row))
  })

  projectRoutes.delete('/:projectId', async (c) => {
    const username = await requireUsername(c.req.header('Authorization'))
    await deleteProject(username, c.req.param('projectId'))
    return c.json(ok({ deleted: true }))
  })

  return projectRoutes
}
