/**
 * Host-facing Hono app factory.
 * Business modules are composed into the API router; Electron/Service hosts only call this.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { proxy } from 'hono/proxy'

export interface CreateHonoAppOptions {
  isDev: boolean
  rendererDevUrl?: string
  staticDir?: string
  /** Fully composed API router (Auth/Settings/Conversation/Design/Execution adapters). */
  api: Hono
}

export function createHonoApp(options: CreateHonoAppOptions): Hono {
  const app = new Hono()

  app.route('/api', options.api)

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
        return c.json(
          {
            success: false,
            status: 40401,
            message: 'Not Found',
            data: { error: 'Not Found' },
            extra: {}
          },
          404
        )
      }
      try {
        const html = readFileSync(join(staticDir, 'index.html'), 'utf-8')
        return c.html(html)
      } catch {
        return c.text('Not Found', 404)
      }
    })
  }

  return app
}
