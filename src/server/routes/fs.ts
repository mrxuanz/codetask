import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { browse, parentBrowsePath } from '../fs'
import { ok } from '../response'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createFsRoutes(_ctx: AppContext): Hono {
  const fs = new Hono()

  fs.post('/browse', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{ partialPath?: string }>()
    const result = browse(body.partialPath ?? '')
    return c.json(ok(result))
  })

  fs.get('/parent', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const path = c.req.query('path') ?? ''
    const parentPath = parentBrowsePath(path)
    return c.json(ok({ parentPath }))
  })

  return fs
}
