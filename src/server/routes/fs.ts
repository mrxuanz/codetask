import { mkdirSync } from 'fs'
import { resolve } from 'path'
import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { AppError } from '../error'
import { browse, parentBrowsePath } from '../fs'
import { ok } from '../response'
import { throwIfCurrentRequestAborted } from '../context/request-abort'

export function createFsRoutes(_ctx: AppContext): Hono {
  const fs = new Hono()

  fs.post('/browse', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{ partialPath?: string }>()
    throwIfCurrentRequestAborted()
    const result = browse(body.partialPath ?? '')
    return c.json(ok(result))
  })

  fs.get('/parent', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    throwIfCurrentRequestAborted()
    const path = c.req.query('path') ?? ''
    const parentPath = parentBrowsePath(path)
    return c.json(ok({ parentPath }))
  })

  fs.post('/mkdir', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{ path?: string }>()
    throwIfCurrentRequestAborted()
    const target = body.path?.trim()
    if (!target) {
      throw AppError.badRequest('Folder name is required', 'folderPicker.folderNameRequired')
    }
    const absolute = resolve(target)
    mkdirSync(absolute, { recursive: true })
    return c.json(ok({ path: absolute }))
  })

  return fs
}
