import { readFileSync } from 'fs'
import { join } from 'path'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { proxy } from 'hono/proxy'
import type { AppContext } from './bootstrap'
import { code } from './error'
import { fail } from './response'
import { createApiRoutes } from './routes/api'

export {
  bootstrapRuntime,
  getAppContext,
  resetAppContextForTests,
  type AppContext,
  type BootstrapOptions
} from './bootstrap'

export interface CreateAppHttpOptions {
  isDev: boolean
  rendererDevUrl?: string
  staticDir?: string
}

export function createApp(ctx: AppContext, options: CreateAppHttpOptions): Hono {
  const app = new Hono()

  app.route('/api', createApiRoutes(ctx))

  if (options.isDev && options.rendererDevUrl) {
    const devOrigin = options.rendererDevUrl.replace(/\/$/, '')

    app.all('*', async (c) => {
      const target = `${devOrigin}${c.req.path}${new URL(c.req.url).search}`
      return proxy(target, c.req.raw)
    })
  } else if (options.staticDir) {
    const staticDir = options.staticDir

    app.use('*', async (c, next) => {
      if (c.req.path.startsWith('/api/')) {
        await next()
        return
      }

      return serveStatic({ root: staticDir })(c, next)
    })

    app.notFound((c) => {
      if (c.req.path.startsWith('/api/')) {
        return c.json(fail(code.NOT_FOUND, 'Not Found', { error: 'Not Found' }), 404)
      }

      const html = readFileSync(join(staticDir, 'index.html'), 'utf-8')
      return c.html(html)
    })
  }

  return app
}

export type { ApiResponse } from './response'
export { ok, fail, okWithExtra } from './response'
export { AppError, code, toErrorResponse } from './error'
