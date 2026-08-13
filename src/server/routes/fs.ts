import { Hono } from 'hono'
import { Type, type Static } from '@sinclair/typebox'
import type { AppContext } from '../context'
import { browse, parentBrowsePath, resolveFolderSelection } from '../fs'
import { ok } from '../response'
import { throwIfCurrentRequestAborted } from '../context/request-abort'
import { parseJsonBody } from '../http/json-body'

const BrowseBodySchema = Type.Object(
  { partialPath: Type.Optional(Type.String()) },
  { additionalProperties: false }
)
const SelectBodySchema = Type.Object(
  {
    path: Type.Optional(Type.String()),
    createIfMissing: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
)
const MkdirBodySchema = Type.Object(
  { path: Type.Optional(Type.String()) },
  { additionalProperties: false }
)

function requestId(c: { get: (key: never) => unknown }): string {
  return (c.get('requestId' as never) as string | undefined) ?? 'unknown'
}

/** Shared folder browser. Authentication belongs to the host composition, not this module. */
export function createFolderBrowserRoutes(): Hono {
  const fs = new Hono()

  fs.post('/browse', async (c) => {
    const body = await parseJsonBody<Static<typeof BrowseBodySchema>>(c, BrowseBodySchema)
    throwIfCurrentRequestAborted()
    const result = browse(body.partialPath ?? '')
    return c.json(ok(result, requestId(c)))
  })

  fs.get('/parent', async (c) => {
    throwIfCurrentRequestAborted()
    const path = c.req.query('path') ?? ''
    const parentPath = parentBrowsePath(path)
    return c.json(ok({ parentPath }, requestId(c)))
  })

  fs.post('/select', async (c) => {
    const body = await parseJsonBody<Static<typeof SelectBodySchema>>(c, SelectBodySchema)
    throwIfCurrentRequestAborted()
    return c.json(
      ok(resolveFolderSelection(body.path ?? '', body.createIfMissing === true), requestId(c))
    )
  })

  // Temporary HTTP compatibility for older renderer bundles. Both endpoints now use the same
  // canonical selection contract and never contain their own filesystem policy.
  fs.post('/mkdir', async (c) => {
    const body = await parseJsonBody<Static<typeof MkdirBodySchema>>(c, MkdirBodySchema)
    throwIfCurrentRequestAborted()
    return c.json(ok(resolveFolderSelection(body.path ?? '', true), requestId(c)))
  })

  return fs
}

export function createFsRoutes(_ctx: AppContext): Hono {
  return createFolderBrowserRoutes()
}
