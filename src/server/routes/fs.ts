import { Hono } from 'hono'
import type { AppContext } from '../context'
import { browse, parentBrowsePath, resolveFolderSelection } from '../fs'
import { ok } from '../response'
import { throwIfCurrentRequestAborted } from '../context/request-abort'

/** Shared folder browser. Authentication belongs to the host composition, not this module. */
export function createFolderBrowserRoutes(): Hono {
  const fs = new Hono()

  fs.post('/browse', async (c) => {
    const body = await c.req.json<{ partialPath?: string }>()
    throwIfCurrentRequestAborted()
    const result = browse(body.partialPath ?? '')
    return c.json(ok(result))
  })

  fs.get('/parent', async (c) => {
    throwIfCurrentRequestAborted()
    const path = c.req.query('path') ?? ''
    const parentPath = parentBrowsePath(path)
    return c.json(ok({ parentPath }))
  })

  fs.post('/select', async (c) => {
    const body = await c.req.json<{ path?: string; createIfMissing?: boolean }>()
    throwIfCurrentRequestAborted()
    return c.json(ok(resolveFolderSelection(body.path ?? '', body.createIfMissing === true)))
  })

  // Temporary HTTP compatibility for older renderer bundles. Both endpoints now use the same
  // canonical selection contract and never contain their own filesystem policy.
  fs.post('/mkdir', async (c) => {
    const body = await c.req.json<{ path?: string }>()
    throwIfCurrentRequestAborted()
    return c.json(ok(resolveFolderSelection(body.path ?? '', true)))
  })

  return fs
}

export function createFsRoutes(_ctx: AppContext): Hono {
  return createFolderBrowserRoutes()
}
